import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../agent-dir";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { callMcpTool, resolveMcpTarget, type McpHttpTarget } from "../mcp-call";
import { getRecentProjects } from "../project-groups";
import { Coalescer, mergeBatches, type BatchedHit, type CoalescedBatch } from "./batch";
import { claimChannel, releaseChannel, type ChannelOwnership } from "./channel-lease";
import { readEventsConfig, usableSubscriptions, type EventSubscription, type EventsConfig } from "./config";
import { EventConnection, type ConnectionState, type EventEndpoint } from "./connection";
import { readGapNotice, streamIdMs, type GapNotice } from "./catch-up";
import { isSessionRunning, wakeSession } from "./delivery";
import { evaluateGates, quotaExhausted, recordGateDelivery, stormReached } from "./gate";
import { renderInjection } from "./inject-text";
import { matchesSubscription, union, type EventDescriptor } from "./match";
import { applyRecheck, snapshotOf, type AggregateSnapshot } from "./recheck";

/**
 * The event-subscription runtime: which sessions asked to be woken, and by what.
 *
 * Ownership (SSR-000097【运行时归属】): one `EventConnection` per
 * `(server, workspace)`, shared by every session and rule that reads that
 * channel; `types` / `entityTypes` are the union over those rules (the server
 * only coarsens, the client decides); `level=envelope`; `cid=<userId>@<server>`.
 *
 * Startup discipline: nothing here runs on the request path or on the boot path.
 * `startEventRuntime()` waits two seconds after instrumentation, then scans
 * asynchronously; the watch pump (`lib/views/watch`) is already running by then,
 * so the two do not touch the network at the same moment.
 *
 * The runtime never writes `.pi/events.yaml`. Bad configuration is *reported*:
 * a rule that cannot be used is listed with its reason instead of being dropped.
 */

export type SubscriptionHealth = "active" | "paused" | "limited" | "unavailable";

export interface SubscriptionChannelState {
  status: ConnectionState["status"];
  attempt: number;
  lastError: string | null;
  gapAt: number | null;
  /**
   * The last stretch of time whose events were not delivered (`gap`), including
   * the `recoveredAt` verdict. Kept after the connection is healthy again
   * precisely because "the channel is fine now" is not the same statement as
   * "you did not miss anything".
   */
  gap: GapNotice | null;
}

/** One received frame, kept for the panel's dry run (M3 / AC-4). */
export interface RecentEvent {
  descriptor: EventDescriptor;
  receivedAt: number;
  catchUp: boolean;
}

interface DeliveryRecord {
  lastWakeAt: number | null;
  day: string;
  dayCount: number;
  total: number;
  lastReason: string | null;
  /** Delivered timestamps of this rule, for `maxPerHour` and the quiet period. */
  delivered: number[];
  /** Delivered timestamps per aggregate id, for the loop fuse. */
  aggregates: Record<string, number[]>;
}

/** One parked batch, as it is written to disk (`pendingBatch` survives a restart). */
interface ParkedBatch {
  subscriptionId: string;
  projectCwd: string | null;
  openedAt: number;
  closedAt: number;
  hits: BatchedHit[];
  count: number;
  /** Whether the parked hits were replayed after a reconnect (`[补投]`). */
  catchUp?: boolean;
  catchUpFrom?: number | null;
  catchUpTo?: number | null;
}

/**
 * Runtime facts of one **session** (as opposed to one rule): the storm fuse, the
 * unread notification count, and the batches waiting for the current turn.
 *
 * Persisted in the same file as the per-rule counters, so a paused session stays
 * paused after a restart — the fuse is not allowed to "heal" itself silently.
 */
interface SessionEventState {
  paused: { at: number; reason: string } | null;
  /** Delivered timestamps of every rule of this session, for the storm fuse. */
  deliveries: number[];
  notify: { unread: number; lastAt: number; lastText: string } | null;
  pending: ParkedBatch[];
}

export interface LoadedRule {
  projectCwd: string;
  sessionId: string;
  title: string | null;
  subscription: EventSubscription;
}

interface ManagedChannel {
  key: string;
  server: string;
  workspace: string;
  projectCwd: string;
  endpoint: EventEndpoint;
  types: string[];
  entityTypes: string[];
  operator: string | null;
  linkTypes: string[];
  custom: boolean;
  connection: EventConnection;
  state: ConnectionState;
}

export interface EventsRuntime {
  started: boolean;
  starting: boolean;
  lastScanAt: number | null;
  lastScanError: string | null;
  scanTimer: ReturnType<typeof setInterval> | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  rules: LoadedRule[];
  channels: Map<string, ManagedChannel>;
  sessionExists: Map<string, boolean>;
  sessionChannels: Map<string, string>;
  deliveries: Map<string, Record<string, DeliveryRecord>>;
  sessionStates: Map<string, SessionEventState>;
  /** Parked batches per session → rule id (`pendingBatch`). */
  pending: Map<string, Map<string, CoalescedBatch>>;
  drainTimers: Map<string, ReturnType<typeof setInterval>>;
  /** Sessions whose persisted pending batches were already re-queued this process. */
  restored: Set<string>;
  chains: Map<string, Promise<void>>;
  /** Last frames per channel, for the dry run. Memory only: a restart forgets them. */
  recent: Map<string, RecentEvent[]>;
  listeners: Set<() => void>;
  coalescer: Coalescer | null;
  scanInFlight: boolean;
  cidCache: Map<string, string>;
}

const globalKey = "__piEventSubscriptions";

function runtime(): EventsRuntime {
  const store = globalThis as unknown as Record<string, EventsRuntime | undefined>;
  let existing = store[globalKey];
  if (!existing) {
    existing = {
      started: false,
      starting: false,
      lastScanAt: null,
      lastScanError: null,
      scanTimer: null,
      startTimer: null,
      rules: [],
      channels: new Map(),
      sessionExists: new Map(),
      sessionChannels: new Map(),
      deliveries: new Map(),
      sessionStates: new Map(),
      pending: new Map(),
      drainTimers: new Map(),
      restored: new Set(),
      chains: new Map(),
      recent: new Map(),
      listeners: new Set(),
      coalescer: null,
      scanInFlight: false,
      cidCache: new Map(),
    };
    store[globalKey] = existing;
  }
  return existing;
}

/** `server|workspace` — one connection per pair. */
export function channelKey(server: string, workspace: string): string {
  return `${server}|${workspace}`;
}

/**
 * `…/entity/mcp` → the sibling event routes. Returns null for an entry that is
 * not an entity-base endpoint: guessing a path from an unrelated URL would point
 * the token at something nobody configured.
 */
export function eventEndpointOf(url: string, headers: Record<string, string>): EventEndpoint | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/entity/mcp")) return null;
  const base = path.slice(0, -"/mcp".length);
  return {
    ticketUrl: `${parsed.origin}${base}/events/ticket`,
    streamUrl: `${parsed.origin}${base}/events/stream`,
    headers,
  };
}

function sessionStateDir(): string {
  return join(agentDir(), "subscriptions");
}

function channelStatePath(key: string): string {
  return join(agentDir(), "events", `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dayKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sessionStatePath(sessionId: string): string {
  return join(sessionStateDir(), `${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

function loadSessionDeliveries(sessionId: string): Record<string, DeliveryRecord> {
  const state = runtime();
  const cached = state.deliveries.get(sessionId);
  if (cached) return cached;
  const raw = readJson(sessionStatePath(sessionId));
  const deliveries: Record<string, DeliveryRecord> = {};
  const stored = raw && isRecord(raw.deliveries) ? raw.deliveries : {};
  for (const [id, value] of Object.entries(stored)) {
    if (!isRecord(value)) continue;
    deliveries[id] = {
      lastWakeAt: typeof value.lastWakeAt === "number" ? value.lastWakeAt : null,
      day: typeof value.day === "string" ? value.day : "",
      dayCount: typeof value.dayCount === "number" ? value.dayCount : 0,
      total: typeof value.total === "number" ? value.total : 0,
      lastReason: typeof value.lastReason === "string" ? value.lastReason : null,
      delivered: numbersOf(value.delivered),
      aggregates: timestampsByKey(value.aggregates),
    };
  }
  state.deliveries.set(sessionId, deliveries);
  return deliveries;
}

function numbersOf(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
}

function timestampsByKey(value: unknown): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  if (!isRecord(value)) return result;
  for (const [key, list] of Object.entries(value)) result[key] = numbersOf(list);
  return result;
}

function loadSessionEventState(sessionId: string): SessionEventState {
  const state = runtime();
  const cached = state.sessionStates.get(sessionId);
  if (cached) return cached;
  const raw = readJson(sessionStatePath(sessionId));
  const stored = raw && isRecord(raw.session) ? raw.session : {};
  const paused = isRecord(stored.paused)
    ? {
        at: typeof stored.paused.at === "number" ? stored.paused.at : 0,
        reason: typeof stored.paused.reason === "string" ? stored.paused.reason : "风暴保护已暂停",
      }
    : null;
  const notify = isRecord(stored.notify)
    ? {
        unread: typeof stored.notify.unread === "number" ? stored.notify.unread : 0,
        lastAt: typeof stored.notify.lastAt === "number" ? stored.notify.lastAt : 0,
        lastText: typeof stored.notify.lastText === "string" ? stored.notify.lastText : "",
      }
    : null;
  const pending: ParkedBatch[] = [];
  if (Array.isArray(stored.pending)) {
    for (const entry of stored.pending) {
      if (!isRecord(entry) || typeof entry.subscriptionId !== "string" || !Array.isArray(entry.hits)) continue;
      pending.push({
        subscriptionId: entry.subscriptionId,
        projectCwd: typeof entry.projectCwd === "string" ? entry.projectCwd : null,
        openedAt: typeof entry.openedAt === "number" ? entry.openedAt : 0,
        closedAt: typeof entry.closedAt === "number" ? entry.closedAt : 0,
        hits: entry.hits.filter(isRecord).map((hit) => ({
          aggregateType: typeof hit.aggregateType === "string" ? hit.aggregateType : "",
          aggregateId: typeof hit.aggregateId === "string" ? hit.aggregateId : "",
          key: typeof hit.key === "string" ? hit.key : null,
          from: typeof hit.from === "string" ? hit.from : null,
          to: typeof hit.to === "string" ? hit.to : null,
          eventType: typeof hit.eventType === "string" ? hit.eventType : "",
          operator: typeof hit.operator === "string" ? hit.operator : "",
          workspaceId: typeof hit.workspaceId === "string" ? hit.workspaceId : "",
          timestamp: typeof hit.timestamp === "string" ? hit.timestamp : "",
          hitCount: typeof hit.hitCount === "number" ? hit.hitCount : 1,
        })).filter((hit) => hit.aggregateId.length > 0),
        count: typeof entry.count === "number" ? entry.count : 0,
        catchUp: entry.catchUp === true,
        catchUpFrom: typeof entry.catchUpFrom === "number" ? entry.catchUpFrom : null,
        catchUpTo: typeof entry.catchUpTo === "number" ? entry.catchUpTo : null,
      });
    }
  }
  const loaded: SessionEventState = {
    paused,
    deliveries: numbersOf(stored.deliveries),
    notify,
    pending,
  };
  state.sessionStates.set(sessionId, loaded);
  return loaded;
}

/** One file per session: per-rule counters + session facts. Losing it must not lose a wake-up. */
function writeSessionState(sessionId: string): void {
  const deliveries = loadSessionDeliveries(sessionId);
  const session = loadSessionEventState(sessionId);
  try {
    mkdirSync(sessionStateDir(), { recursive: true });
    writePrivateFileAtomicSync(
      sessionStatePath(sessionId),
      `${JSON.stringify(
        {
          deliveries,
          session: {
            paused: session.paused,
            deliveries: session.deliveries,
            notify: session.notify,
            pending: session.pending,
          },
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // Losing a counter must not lose the wake-up.
  }
}

function recordDelivery(sessionId: string, subscriptionId: string, outcome: "delivered" | "skipped", reason: string | null): void {
  const deliveries = loadSessionDeliveries(sessionId);
  const now = Date.now();
  const today = dayKey(now);
  const record = deliveries[subscriptionId] ?? {
    lastWakeAt: null,
    day: today,
    dayCount: 0,
    total: 0,
    lastReason: null,
    delivered: [],
    aggregates: {},
  };
  if (outcome === "delivered") {
    record.lastWakeAt = now;
    record.total += 1;
    if (record.day !== today) {
      record.day = today;
      record.dayCount = 0;
    }
    record.dayCount += 1;
  }
  record.lastReason = reason;
  deliveries[subscriptionId] = record;
  writeSessionState(sessionId);
}

/**
 * Per-channel runtime state: where to resume, and which events were already
 * processed.
 *
 * Both live on disk because both survive a restart, and both are needed:
 * `Last-Event-ID` asks the server for what was missed, the processed ring makes
 * the replay idempotent — the feed's replay is inclusive, and a reconnect (or a
 * restart) can therefore hand back the frame the previous connection already
 * acted on. The ring is per channel, not per connection: a new connection object
 * is created on every reconnect and every filter change.
 */
interface ChannelState {
  lastEventId: string | null;
  seen: Set<string>;
  order: string[];
  /** The last `gap` this channel reported; persisted so a restart cannot forget it. */
  gap: GapNotice | null;
  lastWriteAt: number;
}

const SEEN_CAP = 500;
/**
 * How often the cursor + processed ring are written for ordinary live frames.
 *
 * Deliberately short. The ring is what makes a replay idempotent, so anything
 * still sitting in memory when the process dies is delivered a second time after
 * the restart — the one thing SSR-000097 AC-2 forbids. An abrupt kill cannot be
 * caught at all, so the window is kept small and a *replayed* frame (the case a
 * restart is most likely to resend) is written through immediately.
 */
const STATE_WRITE_INTERVAL_MS = 250;
/** Frames kept per channel for the dry run; the panel only needs a recent sample. */
const RECENT_CAP = 200;
const channelStates = new Map<string, ChannelState>();

function loadChannelState(key: string): ChannelState {
  const cached = channelStates.get(key);
  if (cached) return cached;
  const raw = readJson(channelStatePath(key));
  const seen = new Set<string>();
  const order: string[] = [];
  if (raw && Array.isArray(raw.seen)) {
    for (const id of raw.seen) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }
  const state: ChannelState = {
    lastEventId: raw && typeof raw.lastEventId === "string" ? raw.lastEventId : null,
    seen,
    order,
    gap: raw ? readGapNotice(raw.gap) : null,
    lastWriteAt: 0,
  };
  channelStates.set(key, state);
  return state;
}

function writeChannelState(key: string, force = false): void {
  const state = loadChannelState(key);
  const now = Date.now();
  if (!force && now - state.lastWriteAt < STATE_WRITE_INTERVAL_MS) return;
  state.lastWriteAt = now;
  try {
    mkdirSync(join(agentDir(), "events"), { recursive: true });
    writePrivateFileAtomicSync(
      channelStatePath(key),
      `${JSON.stringify({ lastEventId: state.lastEventId, seen: state.order.slice(-SEEN_CAP), gap: state.gap }, null, 2)}
`,
    );
  } catch {
    // Losing a cursor must not stop the wake-up; the next event rewrites it.
  }
}

/** Best-effort durability for a graceful exit; an abrupt kill cannot be caught. */
export function flushChannelStates(): void {
  for (const key of channelStates.keys()) {
    try {
      writeChannelState(key, true);
    } catch {
      // Losing a cursor must not block the exit.
    }
  }
}

let exitFlushInstalled = false;

/** True the first time this event id is seen on this channel. */
function markProcessed(key: string, eventId: string | null): boolean {
  if (!eventId) return true;
  const state = loadChannelState(key);
  if (state.seen.has(eventId)) return false;
  state.seen.add(eventId);
  state.order.push(eventId);
  if (state.order.length > SEEN_CAP) {
    const oldest = state.order.shift();
    if (oldest) state.seen.delete(oldest);
  }
  return true;
}

/**
 * `cid=<userId>@<server>`. The user behind the token comes from `about_me`;
 * when that cannot be read, a digest of the connection config keeps two
 * processes on the same entry comparable without inventing a name.
 */
async function resolveCid(target: McpHttpTarget, serverName: string): Promise<string> {
  const state = runtime();
  const cached = state.cidCache.get(target.fingerprint);
  if (cached) return cached;
  let userId = "";
  const identity = await callMcpTool(target, "about_me", {}, 5_000).catch(() => null);
  if (identity && identity.ok && isRecord(identity.value) && typeof identity.value.userId === "string") {
    userId = identity.value.userId;
  }
  if (!userId) userId = `anon-${createHash("sha1").update(target.fingerprint).digest("hex").slice(0, 8)}`;
  const cid = `${userId}@${serverName}`.slice(0, 64);
  state.cidCache.set(target.fingerprint, cid);
  return cid;
}

async function visibleProjects(): Promise<string[]> {
  // The session reader is the first thing here that needs the pi SDK. It is a
  // 1.5–2.3 s synchronous module load, and it must not happen while the desktop
  // shell is waiting for its identity probe (DEFECT-000090), so it is reached
  // only when a scan actually needs the project list.
  const { listAllSessions } = await import("../session-reader");
  const sessions = await listAllSessions({ allowStale: true });
  return getRecentProjects(sessions).map((project) => project.root);
}

function notifyListeners(): void {
  for (const listener of runtime().listeners) {
    try {
      listener();
    } catch {
      /* a listener must not break the runtime */
    }
  }
}

/** Subscribes to changes of the session → subscriptions picture (for the running SSE). */
export function subscribeSubscriptionRuntime(listener: () => void): () => void {
  const state = runtime();
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

async function collectRules(): Promise<{ rules: LoadedRule[]; configs: Map<string, EventsConfig> }> {
  const projects = await visibleProjects();
  const rules: LoadedRule[] = [];
  const configs = new Map<string, EventsConfig>();
  for (const projectCwd of projects) {
    const config = readEventsConfig(projectCwd);
    configs.set(projectCwd, config);
    if (!config.exists || config.error) continue;
    for (const loaded of usableSubscriptions(config)) {
      rules.push({ projectCwd, ...loaded });
    }
  }
  return { rules, configs };
}

export interface ChannelShape {
  server: string;
  workspace: string;
  projectCwd: string;
  types: string[];
  entityTypes: string[];
  /** Coarse server-side dimensions (`filter`), unioned over the channel's rules. */
  operator: string | null;
  linkTypes: string[];
  custom: boolean;
}

/**
 * One entry per `(server, workspace)` with the union of its rules' filters.
 *
 * `operator` is the one dimension a union cannot honestly widen: the server takes
 * a single value, and sending one rule's operator would silently starve another
 * rule on the same channel. It is sent only when every rule that names one names
 * the same; `match.operator` still enforces it per rule either way.
 */
export function desiredChannels(rules: LoadedRule[]): Map<string, ChannelShape> {
  const wanted = new Map<string, ChannelShape>();
  const operators = new Map<string, Set<string>>();
  for (const rule of rules) {
    const key = channelKey(rule.subscription.server, rule.subscription.workspace);
    const entry = wanted.get(key) ?? {
      server: rule.subscription.server,
      workspace: rule.subscription.workspace,
      projectCwd: rule.projectCwd,
      types: [],
      entityTypes: [],
      operator: null,
      linkTypes: [],
      custom: false,
    };
    entry.types.push(...rule.subscription.filter.events);
    entry.entityTypes.push(...rule.subscription.filter.entityTypes);
    entry.linkTypes.push(...rule.subscription.filter.linkTypes);
    if (rule.subscription.filter.custom === true) entry.custom = true;
    if (rule.subscription.filter.operator) {
      const set = operators.get(key) ?? new Set<string>();
      set.add(rule.subscription.filter.operator);
      operators.set(key, set);
    }
    wanted.set(key, entry);
  }
  for (const [key, entry] of wanted) {
    entry.types = union(entry.types);
    entry.entityTypes = union(entry.entityTypes);
    entry.linkTypes = union(entry.linkTypes);
    const named = operators.get(key);
    entry.operator = named && named.size === 1 ? [...named][0] : null;
  }
  return wanted;
}

async function refreshScan(): Promise<void> {
  const state = runtime();
  if (state.scanInFlight) return;
  state.scanInFlight = true;
  try {
    const { rules } = await collectRules();
    state.rules = rules;

    // Session existence, once per scan: a rule pointing at a deleted session is
    // reported, never re-created and never edited out of the file.
    const sessionIds = [...new Set(rules.map((rule) => rule.sessionId))];
    const exists = new Map<string, boolean>();
    const { resolveSessionPath } = await import("../session-reader");
    for (const sessionId of sessionIds) {
      try {
        exists.set(sessionId, Boolean(await resolveSessionPath(sessionId)));
      } catch {
        exists.set(sessionId, false);
      }
    }
    state.sessionExists = exists;

    // `pendingBatch` outlives a restart: a batch parked behind a turn that the
    // app never saw end is delivered once the session is idle again. A rule that
    // no longer exists (or is no longer usable) is dropped instead of delivered.
    for (const sessionId of sessionIds) {
      if (state.restored.has(sessionId)) continue;
      state.restored.add(sessionId);
      const session = loadSessionEventState(sessionId);
      if (session.pending.length === 0) continue;
      const rulesOfSession = new Map(
        rules.filter((rule) => rule.sessionId === sessionId).map((rule) => [rule.subscription.id, rule]),
      );
      const parked = new Map<string, CoalescedBatch>();
      for (const entry of session.pending) {
        const rule = rulesOfSession.get(entry.subscriptionId);
        if (!rule || rule.subscription.action === "notify") continue;
        parked.set(entry.subscriptionId, {
          sessionId,
          subscription: rule.subscription,
          projectCwd: entry.projectCwd ?? rule.projectCwd,
          openedAt: entry.openedAt,
          closedAt: entry.closedAt,
          hits: entry.hits,
          count: entry.count,
          catchUp: entry.catchUp,
          catchUpFrom: entry.catchUpFrom,
          catchUpTo: entry.catchUpTo,
        });
      }
      session.pending = [];
      writeSessionState(sessionId);
      if (parked.size > 0) {
        state.pending.set(sessionId, parked);
        scheduleDrain(sessionId);
      }
    }

    const wanted = desiredChannels(rules);
    const reshaped = new Set<string>();
    const claimDir = join(agentDir(), "events");
    for (const [key, channel] of [...state.channels]) {
      const entry = wanted.get(key);
      const sameShape = entry
        && entry.types.join(",") === channel.types.join(",")
        && entry.entityTypes.join(",") === channel.entityTypes.join(",")
        && entry.operator === channel.operator
        && entry.linkTypes.join(",") === channel.linkTypes.join(",")
        && entry.custom === channel.custom;
      if (entry && sameShape) {
        // Superseded is not permanent: the other instance may have gone away.
        // One local claim check per scan — never a network round trip — and the
        // channel is reopened only when this process is the newest live owner.
        if (channel.state.status === "superseded" && claimChannel(claimDir, key).owner) {
          channel.connection?.stop?.();
          state.channels.delete(key);
        }
        continue;
      }
      // A changed union needs a new connection: the server's filter is fixed at
      // connect time.
      channel.connection.stop();
      state.channels.delete(key);
      if (entry) reshaped.add(key);
    }

    for (const [key, entry] of wanted) {
      if (state.channels.has(key)) continue;
      // A reshaped channel starts from now; only a genuine reconnect resumes.
      await startChannel(key, entry, { resume: !reshaped.has(key) });
    }

    state.lastScanAt = Date.now();
    state.lastScanError = null;
    notifyListeners();
  } catch (error) {
    state.lastScanError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scanInFlight = false;
  }
}

async function startChannel(
  key: string,
  entry: ChannelShape,
  options: { resume: boolean } = { resume: true },
): Promise<void> {
  const state = runtime();
  const resolved = resolveMcpTarget(agentDir(), entry.projectCwd, entry.server);
  if (!resolved.ok) {
    // Reported by the status API from the same resolution, so no connection is
    // registered for a channel that cannot exist.
    return;
  }
  const endpoint = eventEndpointOf(resolved.target.url, resolved.target.headers);
  if (!endpoint) return;

  const cid = await resolveCid(resolved.target, entry.server);
  const claimDir = join(agentDir(), "events");
  const isChannelOwner = (): ChannelOwnership => claimChannel(claimDir, key);
  const ownership = isChannelOwner();
  if (!ownership.owner) {
    // Recorded, not silently dropped: the panel says "另一实例接管".
    state.channels.set(key, {
      key,
      server: entry.server,
      workspace: entry.workspace,
      projectCwd: entry.projectCwd,
      endpoint,
      types: entry.types,
      entityTypes: entry.entityTypes,
      operator: entry.operator,
      linkTypes: entry.linkTypes,
      custom: entry.custom,
      connection: null as unknown as EventConnection,
      state: {
        status: "superseded",
        attempt: 0,
        nextRetryMs: null,
        lastError: ownership.reason,
        connectionId: null,
        gapAt: null,
        gap: null,
        lastEventId: null,
      },
    });
    return;
  }

  const connection = new EventConnection({
    key,
    serverName: entry.server,
    workspaceId: entry.workspace,
    endpoint,
    types: entry.types,
    entityTypes: entry.entityTypes,
    operator: entry.operator,
    linkTypes: entry.linkTypes,
    custom: entry.custom,
    cid,
    // A widened filter is a new subscription set: replaying it from an old
    // cursor would deliver events that were not relevant when they happened
    // (and read as fresh facts now). Only a reconnect of the same filter resumes.
    lastEventId: options.resume ? loadChannelState(key).lastEventId : null,
    isChannelOwner,
    onEvent: (descriptor, meta) => handleEvent(key, descriptor, meta.id, meta.catchUp),
    onGap: (notice, info) => {
      // Written down twice on purpose: `state.channels` is what the status API
      // answers from, the channel file is what a restart reads. A `gap` that
      // "healed" on reconnect would hide the window that was never delivered.
      const channelState = loadChannelState(key);
      channelState.gap = notice;
      writeChannelState(key, true);
      const channel = state.channels.get(key);
      if (channel) {
        channel.state = {
          ...channel.state,
          gapAt: channel.state.gapAt ?? notice.at,
          gap: notice,
          lastError: `这段时间的事件没有投递（gap：${notice.reason}）`,
        };
      }
      console.info(
        `[events] gap channel=${key} reason=${notice.reason} window=${notice.from ?? "?"}..${notice.to ?? "?"} retrying=${info.retrying}`,
      );
      notifyListeners();
    },
    onState: (connectionState) => {
      const channel = state.channels.get(key);
      if (!channel) return;
      channel.state = connectionState;
      notifyListeners();
    },
  });

  state.channels.set(key, {
    key,
    server: entry.server,
    workspace: entry.workspace,
    projectCwd: entry.projectCwd,
    endpoint,
    types: entry.types,
    entityTypes: entry.entityTypes,
    operator: entry.operator,
    linkTypes: entry.linkTypes,
    custom: entry.custom,
    connection,
    state: connection.getState(),
  });
  connection.start();
}

function ruleAppliesToChannel(rule: LoadedRule, key: string): boolean {
  return channelKey(rule.subscription.server, rule.subscription.workspace) === key;
}

function handleEvent(key: string, descriptor: EventDescriptor, eventId: string | null, catchUp: boolean): void {
  const state = runtime();
  const channelState = loadChannelState(key);
  if (eventId) channelState.lastEventId = eventId;
  // A frame the previous connection (or the previous process) already handled
  // must not be delivered twice: the injection would be a second, stale wake-up.
  if (!markProcessed(key, descriptor.eventId)) return;
  // A replayed frame is written through at once: a second restart would hand the
  // same window back, and it must find this event id already in the ring.
  writeChannelState(key, catchUp);
  if (!state.channels.has(key)) return;

  // The dry run reads this ring: it is "what the channel actually carried",
  // which is the only honest basis for "would this rule have fired?".
  const recent = state.recent.get(key) ?? [];
  recent.push({ descriptor, receivedAt: Date.now(), catchUp });
  if (recent.length > RECENT_CAP) recent.splice(0, recent.length - RECENT_CAP);
  state.recent.set(key, recent);

  const publishedAt = streamIdMs(eventId) ?? (Number.isNaN(Date.parse(descriptor.timestamp)) ? null : Date.parse(descriptor.timestamp));
  for (const rule of state.rules) {
    if (!ruleAppliesToChannel(rule, key)) continue;
    if (rule.subscription.workspace !== descriptor.workspaceId && descriptor.workspaceId) continue;
    if (!matchesSubscription(descriptor, rule.subscription.match)) continue;
    state.coalescer?.add(rule.sessionId, rule.subscription, descriptor, rule.projectCwd, { catchUp, publishedAt });
  }
}

function deliverBatch(batch: CoalescedBatch): void {
  const state = runtime();
  const previous = state.chains.get(batch.sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => deliverNow(batch))
    .finally(() => {
      if (state.chains.get(batch.sessionId) === next) state.chains.delete(batch.sessionId);
    });
  state.chains.set(batch.sessionId, next);
}

const RECHECK_TIMEOUT_MS = 8_000;
const PENDING_DRAIN_MS = 1_000;

/**
 * Re-read every aggregate of the batch through the very same MCP entry the rule
 * names, and drop the hits whose entity no longer satisfies the rule.
 *
 * A failed read is *not* "probably fine": injecting a state we could not confirm
 * is exactly the mistake `recheck` exists to prevent, so the batch is skipped
 * with its reason written down (`skipped:recheck-failed`).
 */
async function recheckBatch(batch: CoalescedBatch): Promise<{ batch: CoalescedBatch | null; stale: string[]; error: string | null }> {
  const resolved = resolveMcpTarget(agentDir(), batch.projectCwd ?? "", batch.subscription.server);
  if (!resolved.ok) return { batch: null, stale: [], error: `无法解析 mcp.json 条目：${resolved.error}` };

  const snapshots = new Map<string, AggregateSnapshot>();
  for (const hit of batch.hits) {
    const result = await callMcpTool(
      resolved.target,
      "get",
      { id: hit.aggregateId, includeAttachments: false },
      RECHECK_TIMEOUT_MS,
    );
    if (!result.ok) {
      const status = typeof result.structured?.statusCode === "number" ? result.structured.statusCode : null;
      if (status === 404) {
        snapshots.set(hit.aggregateId, { exists: false, state: null, aggregateType: null, workspaceId: null });
        continue;
      }
      return { batch: null, stale: [], error: `重读 ${hit.aggregateId} 失败：${result.error}` };
    }
    snapshots.set(hit.aggregateId, snapshotOf(result.value, batch.subscription.workspace));
  }

  const outcome = applyRecheck(batch, snapshots, batch.subscription.match, batch.subscription.workspace);
  return { batch: outcome.batch, stale: outcome.stale, error: null };
}

function parkedOf(batch: CoalescedBatch): ParkedBatch {
  return {
    subscriptionId: batch.subscription.id,
    projectCwd: batch.projectCwd,
    openedAt: batch.openedAt,
    closedAt: batch.closedAt,
    hits: batch.hits,
    count: batch.count,
    catchUp: batch.catchUp,
    catchUpFrom: batch.catchUpFrom ?? null,
    catchUpTo: batch.catchUpTo ?? null,
  };
}

/** Keeps a batch for after the current turn; more windows of the same rule merge into it. */
function parkBatch(batch: CoalescedBatch): void {
  const state = runtime();
  const parked = state.pending.get(batch.sessionId) ?? new Map<string, CoalescedBatch>();
  const existing = parked.get(batch.subscription.id);
  parked.set(batch.subscription.id, existing ? mergeBatches(existing, batch) : batch);
  state.pending.set(batch.sessionId, parked);

  const session = loadSessionEventState(batch.sessionId);
  session.pending = [...parked.values()].map(parkedOf);
  writeSessionState(batch.sessionId);
  scheduleDrain(batch.sessionId);
  notifyListeners();
}

function stopDrain(sessionId: string): void {
  const state = runtime();
  const timer = state.drainTimers.get(sessionId);
  if (timer) clearInterval(timer);
  state.drainTimers.delete(sessionId);
}

function scheduleDrain(sessionId: string): void {
  const state = runtime();
  if (state.drainTimers.has(sessionId)) return;
  const timer = setInterval(() => void attemptDrain(sessionId), PENDING_DRAIN_MS);
  (timer as { unref?: () => void }).unref?.();
  state.drainTimers.set(sessionId, timer);
}

/** After the turn: deliver every parked batch once, through the usual gates. */
async function attemptDrain(sessionId: string): Promise<void> {
  const state = runtime();
  const parked = state.pending.get(sessionId);
  if (!parked || parked.size === 0) {
    stopDrain(sessionId);
    return;
  }
  if (await isSessionRunning(sessionId)) return;

  stopDrain(sessionId);
  state.pending.delete(sessionId);
  const session = loadSessionEventState(sessionId);
  session.pending = [];
  writeSessionState(sessionId);
  for (const batch of parked.values()) deliverBatch(batch);
  notifyListeners();
}

/** Delivered: stamps the rule's quota/loop history and the session's storm history. */
function markDelivered(batch: CoalescedBatch): { storm: boolean; count: number } {
  const subscription = batch.subscription;
  const deliveries = loadSessionDeliveries(batch.sessionId);
  const now = Date.now();
  const today = dayKey(now);
  const record = deliveries[subscription.id] ?? {
    lastWakeAt: null,
    day: today,
    dayCount: 0,
    total: 0,
    lastReason: null,
    delivered: [],
    aggregates: {},
  };
  const gated = recordGateDelivery(record.delivered, record.aggregates, batch.hits, now);
  record.delivered = gated.delivered;
  record.aggregates = gated.aggregateDeliveries;
  record.lastWakeAt = now;
  record.total += 1;
  if (record.day !== today) {
    record.day = today;
    record.dayCount = 0;
  }
  record.dayCount += 1;
  record.lastReason = subscription.action === "notify" ? `notify：${batch.count} 条变化` : null;
  deliveries[subscription.id] = record;

  const session = loadSessionEventState(batch.sessionId);
  session.deliveries = [...session.deliveries, now].slice(-200);
  const storm = stormReached(session.deliveries, now, subscription.stormWindowSec, subscription.stormMaxDeliveries);
  if (storm.tripped && !session.paused) {
    session.paused = {
      at: now,
      reason: `${Math.round(subscription.stormWindowSec / 60)} 分钟内已投递 ${storm.count} 次（上限 ${subscription.stormMaxDeliveries}）：已暂停本会话全部订阅，不会自动恢复`,
    };
  }
  writeSessionState(batch.sessionId);
  if (storm.tripped && session.paused) {
    void sendSystemNotification(
      batch.sessionId,
      "事件订阅已暂停（风暴保护）",
      session.paused.reason,
    );
  }
  return { storm: storm.tripped, count: storm.count };
}

function notificationText(batch: CoalescedBatch): { title: string; text: string } {
  const latest = batch.hits[batch.hits.length - 1];
  const subject = latest
    ? `${latest.aggregateType} ${latest.key ?? latest.aggregateId}${batch.hits.length > 1 ? ` 等 ${batch.hits.length} 个实体` : ""}`
    : "";
  return {
    title: `${batch.subscription.name}（事件提醒）`,
    text: [
      `${batch.count} 条变化`,
      subject ? `：${subject}` : "",
      latest?.to ? `，现在 ${latest.from ?? "?"} → ${latest.to}` : "",
    ].join(""),
  };
}

/**
 * A system notification and no injection (`action: notify`).
 *
 * Two receipts, because either alone is easy to miss: the browser/phone push
 * (`notifySessionEvent`) and the unread counter the sidebar turns into the same
 * dot a completed background run gets. No prompt is sent, so no token is spent.
 */
async function sendSystemNotification(sessionId: string, title: string, text: string): Promise<void> {
  try {
    const push = await import("../web-push");
    await push.notifySessionEvent(sessionId, { kind: "attention", detail: text }, title);
  } catch (error) {
    console.error(
      "[events] system notification failed:",
      error instanceof Error ? error.message : error,
    );
  }
  // A line in the app log is the third receipt: "was I notified?" is answerable
  // from the outside when push is not configured on this machine.
  console.info(`[events] notify session=${sessionId} ${title}：${text}`);
}

async function deliverNotification(batch: CoalescedBatch): Promise<void> {
  const { title, text } = notificationText(batch);
  const session = loadSessionEventState(batch.sessionId);
  session.notify = {
    unread: (session.notify?.unread ?? 0) + 1,
    lastAt: Date.now(),
    lastText: text,
  };
  markDelivered(batch);
  await sendSystemNotification(batch.sessionId, title, text);
  notifyListeners();
}

/** One batch into one session, never two at a time (`state.chains`). */
async function deliverNow(batch: CoalescedBatch): Promise<void> {
  const state = runtime();
  const subscription = batch.subscription;
  const skip = (reason: string): void => {
    recordDelivery(batch.sessionId, subscription.id, "skipped", reason);
    notifyListeners();
  };

  if (state.sessionExists.get(batch.sessionId) === false) {
    skip("会话不存在");
    return;
  }

  const session = loadSessionEventState(batch.sessionId);
  if (session.paused) {
    skip(`skipped:paused：${session.paused.reason}`);
    return;
  }

  // ① recheck — after coalescing, before any counter is charged.
  let effective = batch;
  if (subscription.recheck) {
    const result = await recheckBatch(batch);
    if (result.error) {
      skip(`skipped:recheck-failed：${result.error}`);
      return;
    }
    if (!result.batch) {
      skip(`skipped:stale：重读后已不满足 match（${result.stale.join("、")}）`);
      return;
    }
    effective = result.batch;
  }

  // ② quota, quiet period, loop fuse — on the coalesced batch, never on raw events.
  const deliveries = loadSessionDeliveries(batch.sessionId);
  const record = deliveries[subscription.id];
  const verdict = evaluateGates({
    now: Date.now(),
    selfQuietSec: subscription.selfQuietSec,
    lastDeliveredAt: record?.lastWakeAt ?? null,
    delivered: record?.delivered ?? [],
    maxPerHour: subscription.maxPerHour,
    loopWindowSec: subscription.loopWindowSec,
    loopMaxHits: subscription.loopMaxHits,
    aggregateDeliveries: record?.aggregates ?? {},
    hits: effective.hits,
  });
  if (verdict.skip) {
    skip(`skipped:${verdict.skip}：${verdict.detail}`);
    return;
  }

  // ③ `notify` never interrupts a turn, so it is delivered even while one runs.
  if (subscription.action === "notify") {
    await deliverNotification(effective);
    return;
  }

  // ④ Busy: park the batch; the drain delivers it once when the turn ends.
  if (await isSessionRunning(batch.sessionId)) {
    parkBatch(effective);
    return;
  }

  const { text, subscriptionId } = renderInjection(effective);
  const outcome = await wakeSession(batch.sessionId, text);
  if (outcome.status === "busy") {
    parkBatch(effective);
    return;
  }
  if (outcome.status === "delivered") {
    markDelivered(effective);
    notifyListeners();
    return;
  }
  skip(`${outcome.reason}（${subscriptionId}）`);
}

/**
 * Starts the runtime. Idempotent; the first scan happens `delayMs` later so
 * nothing about a connection is on the startup path.
 */
export function startEventRuntime(options: { delayMs?: number; scanIntervalMs?: number } = {}): void {
  const state = runtime();
  if (state.started || state.starting) return;
  state.starting = true;

  const begin = () => {
    const current = runtime();
    current.started = true;
    current.starting = false;
    current.startTimer = null;
    current.coalescer = new Coalescer((batch) => deliverBatch(batch));
    if (!exitFlushInstalled) {
      exitFlushInstalled = true;
      // Not a substitute for the write-through above: it only helps the exits
      // that are actually graceful.
      process.once("exit", flushChannelStates);
    }
    void refreshScan();
    const interval = options.scanIntervalMs ?? 15_000;
    current.scanTimer = setInterval(() => void refreshScan(), interval);
    (current.scanTimer as { unref?: () => void }).unref?.();
  };

  const delayMs = options.delayMs ?? 2_000;
  const timer = setTimeout(begin, delayMs);
  (timer as { unref?: () => void }).unref?.();
  state.startTimer = timer;
  // The first connection must not exist before the window is usable.
  if (delayMs <= 0) begin();
}

/** Test/shutdown hook: stops every connection and timer. */
export function stopEventRuntime(): void {
  const state = runtime();
  if (state.startTimer) clearTimeout(state.startTimer);
  if (state.scanTimer) clearInterval(state.scanTimer);
  state.startTimer = null;
  state.scanTimer = null;
  for (const sessionId of [...state.drainTimers.keys()]) stopDrain(sessionId);
  state.pending.clear();
  state.restored.clear();
  state.coalescer?.dispose();
  state.coalescer = null;
  for (const [key, channel] of state.channels) {
    (channel.connection as EventConnection | null)?.stop?.();
    releaseChannel(join(agentDir(), "events"), key);
  }
  for (const key of channelStates.keys()) writeChannelState(key, true);
  state.channels.clear();
  state.rules = [];
  state.started = false;
  state.starting = false;
  state.lastScanAt = null;
  notifyListeners();
}

/** Forces one scan (tests, and the "復位" path after a config edit). */
export async function scanEventRuntimeNow(): Promise<void> {
  if (!runtime().started) return;
  await refreshScan();
}

// ---------------------------------------------------------------------------
// Status surface (the status API and the running-state stream read from here)
// ---------------------------------------------------------------------------

export interface RuleRuntimeStatus {
  id: string;
  lastWakeAt: number | null;
  todayCount: number;
  totalDeliveries: number;
  lastReason: string | null;
  connection: SubscriptionChannelState | null;
  /** Why the rule cannot fire, decided here (connection/channel/action). */
  blockedReason: string | null;
  /** The hourly quota is used up (`maxPerHour`): health `limited`. */
  limited: boolean;
  limitedReason: string | null;
  /** Delivered in the rolling hour, for the tooltip. */
  hourlyCount: number;
  /** Batches waiting for this session's current turn to end. */
  pendingCount: number;
}

export function ruleRuntimeStatus(sessionId: string, subscription: EventSubscription): RuleRuntimeStatus {
  const state = runtime();
  const deliveries = loadSessionDeliveries(sessionId)[subscription.id];
  const key = channelKey(subscription.server, subscription.workspace);
  const channel = state.channels.get(key);
  const now = Date.now();
  const today = dayKey(now);
  const todayCount = deliveries && deliveries.day === today ? deliveries.dayCount : 0;
  const hourlyCount = deliveries ? deliveries.delivered.filter((time) => time > now - 3_600_000).length : 0;
  const session = loadSessionEventState(sessionId);
  const pendingCount = state.pending.get(sessionId)?.size ?? 0;

  let blockedReason: string | null = null;
  // The storm fuse outranks everything: no rule of this session will fire again
  // until a person clears it.
  if (session.paused) blockedReason = session.paused.reason;
  else if (!channel) blockedReason = state.started ? "事件连接尚未建立（或该 server 不可用）" : "事件订阅尚未启动（启动后 2s 惰性连接）";
  else if (channel.state.status === "superseded") blockedReason = channel.state.lastError ?? "另一实例接管了事件连接";
  else if (channel.state.status === "auth_failed") blockedReason = channel.state.lastError ?? "凭据失效";
  else if (channel.state.status === "reconnecting") blockedReason = channel.state.lastError ? `重连中：${channel.state.lastError}` : "重连中";
  else if (channel.state.status === "unavailable") blockedReason = channel.state.lastError ?? "事件通道不可用";

  const limited = quotaExhausted(deliveries?.delivered ?? [], now, subscription.maxPerHour);

  return {
    id: subscription.id,
    lastWakeAt: deliveries?.lastWakeAt ?? null,
    todayCount,
    totalDeliveries: deliveries?.total ?? 0,
    lastReason: deliveries?.lastReason ?? null,
    connection: channel
      ? {
          status: channel.state.status,
          attempt: channel.state.attempt,
          lastError: channel.state.lastError,
          gapAt: channel.state.gapAt,
          // The file, not the live connection: a `gap` written before this
          // process started is still a window nobody was woken for.
          gap: loadChannelState(key).gap ?? channel.state.gap ?? null,
        }
      : null,
    blockedReason,
    limited,
    limitedReason: limited ? `一小时内已投递 ${hourlyCount} 次（maxPerHour: ${subscription.maxPerHour}）` : null,
    hourlyCount,
    pendingCount,
  };
}

export function subscriptionHealthOf(rule: RuleRuntimeStatus, sessionExists: boolean): SubscriptionHealth {
  if (!sessionExists) return "unavailable";
  // Paused by the storm fuse, or another app instance owns the channel.
  if (rule.connection?.status === "superseded") return "paused";
  switch (rule.connection?.status) {
    case "auth_failed":
    case "unavailable":
    case "reconnecting":
    case "idle":
      return "unavailable";
    default:
      break;
  }
  if (rule.blockedReason) return "paused";
  if (rule.limited) return "limited";
  return "active";
}

export interface SessionRuntimeHealth {
  health: SubscriptionHealth;
  reason: string | null;
}

/** How one session's subscriptions look as a whole, for the list badge. */
export function sessionSubscriptionHealth(sessionId: string, subscriptions: EventSubscription[]): SessionRuntimeHealth {
  if (subscriptions.length === 0) return { health: "active", reason: null };
  const state = runtime();
  const known = state.sessionExists.has(sessionId) ? state.sessionExists.get(sessionId)! : null;
  if (known === false) return { health: "unavailable", reason: "会话不存在" };
  if (!state.started) return { health: "paused", reason: "事件订阅尚未启动" };

  let health: SubscriptionHealth = "active";
  let reason: string | null = null;
  for (const subscription of subscriptions) {
    const rule = ruleRuntimeStatus(sessionId, subscription);
    // `known === false` returned above; an unknown session is not reported as
    // missing (the scan will say so on its next pass).
    const ruleHealth = subscriptionHealthOf(rule, true);
    if (ruleHealth === "paused") {
      health = "paused";
      reason ??= rule.blockedReason;
    } else if (ruleHealth === "unavailable" && health !== "paused") {
      health = "unavailable";
      reason ??= rule.blockedReason;
    } else if (ruleHealth === "limited" && health === "active") {
      health = "limited";
      reason ??= rule.limitedReason;
    }
  }
  return { health, reason };
}

/**
 * The two fields `/api/agent/running` adds (SSR-000097【会话列表标记】), plus the
 * unread notifications of `action: notify` rules — the sidebar turns an increase
 * into the same dot a completed background run gets.
 * Read from the runtime's last scan; never queries the network.
 */
export function getSubscriptionRuntimeSnapshot(): {
  subscribedSessionIds: string[];
  subscriptionHealth: Record<string, SubscriptionHealth>;
  reasons: Record<string, string | null>;
  notifications: Record<string, { unread: number; lastAt: number; text: string }>;
} {
  const state = runtime();
  const bySession = new Map<string, EventSubscription[]>();
  for (const rule of state.rules) {
    const list = bySession.get(rule.sessionId) ?? [];
    list.push(rule.subscription);
    bySession.set(rule.sessionId, list);
  }
  const subscribedSessionIds = [...bySession.keys()].sort();
  const subscriptionHealth: Record<string, SubscriptionHealth> = {};
  const reasons: Record<string, string | null> = {};
  for (const [sessionId, subscriptions] of bySession) {
    const verdict = sessionSubscriptionHealth(sessionId, subscriptions);
    subscriptionHealth[sessionId] = verdict.health;
    reasons[sessionId] = verdict.reason;
  }
  const notifications: Record<string, { unread: number; lastAt: number; text: string }> = {};
  for (const [sessionId, session] of state.sessionStates) {
    if (!session.notify || session.notify.unread <= 0) continue;
    notifications[sessionId] = {
      unread: session.notify.unread,
      lastAt: session.notify.lastAt,
      text: session.notify.lastText,
    };
  }
  return { subscribedSessionIds, subscriptionHealth, reasons, notifications };
}

/**
 * The unread notifications of one session, cleared when a person opens it.
 * Called from the session route (opening the conversation is "I have seen it"),
 * never from the event runtime itself.
 */
export function markEventsRead(sessionId: string): void {
  const session = loadSessionEventState(sessionId);
  if (!session.notify || session.notify.unread === 0) return;
  session.notify = { ...session.notify, unread: 0 };
  writeSessionState(sessionId);
  notifyListeners();
}

/** Per-session event facts for the status route (unread, pending, paused). */
export function sessionEventFacts(sessionId: string): {
  unread: number;
  lastNotifyAt: number | null;
  lastNotifyText: string | null;
  pending: number;
  pausedReason: string | null;
} {
  const state = runtime();
  const session = loadSessionEventState(sessionId);
  return {
    unread: session.notify?.unread ?? 0,
    lastNotifyAt: session.notify?.lastAt ?? null,
    lastNotifyText: session.notify?.lastText ?? null,
    pending: state.pending.get(sessionId)?.size ?? 0,
    pausedReason: session.paused?.reason ?? null,
  };
}

/** Where the runtime is, for the status panel's "why is nothing happening". */
export function getEventRuntimeStatus(): {
  started: boolean;
  lastScanAt: number | null;
  lastScanError: string | null;
  channels: { key: string; server: string; workspace: string; state: SubscriptionChannelState }[];
  pending: { sessionId: string; batches: number }[];
} {
  const state = runtime();
  return {
    started: state.started,
    lastScanAt: state.lastScanAt,
    lastScanError: state.lastScanError,
    channels: [...state.channels.values()].map((channel) => ({
      key: channel.key,
      server: channel.server,
      workspace: channel.workspace,
      state: {
        status: channel.state.status,
        attempt: channel.state.attempt,
        lastError: channel.state.lastError,
        gapAt: channel.state.gapAt,
        gap: loadChannelState(channel.key).gap ?? channel.state.gap ?? null,
      },
    })),
    pending: [...state.pending.entries()].map(([sessionId, parked]) => ({ sessionId, batches: parked.size })),
  };
}

/**
 * The frames this channel has carried since the runtime started, newest last.
 * The dry run (M3 / AC-4) reads them; nothing here touches delivery
 * state, so asking "would this rule have fired?" can never wake anything.
 */
export function recentEventsOf(server: string, workspace: string): RecentEvent[] {
  return [...(runtime().recent.get(channelKey(server, workspace)) ?? [])];
}

/** Whether the last scan found the session; null when it has not looked yet. */
export function sessionExistence(sessionId: string): boolean | null {
  const map = runtime().sessionExists;
  return map.has(sessionId) ? map.get(sessionId)! : null;
}

/** Every usable rule the runtime knows, for the status API's cross-check. */
export function loadedRules(): { sessionId: string; title: string | null; subscription: EventSubscription }[] {
  return runtime().rules.map((rule) => ({ sessionId: rule.sessionId, title: rule.title, subscription: rule.subscription }));
}
