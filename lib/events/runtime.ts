import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { callMcpTool, resolveMcpTarget, type McpHttpTarget } from "../mcp-call";
import { getRecentProjects } from "../project-groups";
import { listAllSessions, resolveSessionPath } from "../session-reader";
import { Coalescer, type CoalescedBatch } from "./batch";
import { claimChannel, releaseChannel, type ChannelOwnership } from "./channel-lease";
import { readEventsConfig, usableSubscriptions, type EventSubscription, type EventsConfig } from "./config";
import { EventConnection, type ConnectionState, type EventEndpoint } from "./connection";
import { wakeSession } from "./delivery";
import { renderInjection } from "./inject-text";
import { matchesSubscription, union, type EventDescriptor } from "./match";

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
}

interface DeliveryRecord {
  lastWakeAt: number | null;
  day: string;
  dayCount: number;
  total: number;
  lastReason: string | null;
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
  chains: Map<string, Promise<void>>;
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
      chains: new Map(),
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
  return join(getAgentDir(), "subscriptions");
}

function channelStatePath(key: string): string {
  return join(getAgentDir(), "events", `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
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

function loadSessionDeliveries(sessionId: string): Record<string, DeliveryRecord> {
  const state = runtime();
  const cached = state.deliveries.get(sessionId);
  if (cached) return cached;
  const raw = readJson(join(sessionStateDir(), `${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`));
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
    };
  }
  state.deliveries.set(sessionId, deliveries);
  return deliveries;
}

function recordDelivery(sessionId: string, subscriptionId: string, outcome: "delivered" | "skipped", reason: string | null): void {
  const deliveries = loadSessionDeliveries(sessionId);
  const now = Date.now();
  const today = dayKey(now);
  const record = deliveries[subscriptionId] ?? { lastWakeAt: null, day: today, dayCount: 0, total: 0, lastReason: null };
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
  try {
    mkdirSync(sessionStateDir(), { recursive: true });
    writePrivateFileAtomicSync(
      join(sessionStateDir(), `${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`),
      `${JSON.stringify({ deliveries }, null, 2)}\n`,
    );
  } catch {
    // Losing a counter must not lose the wake-up.
  }
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
  lastWriteAt: number;
}

const SEEN_CAP = 500;
const STATE_WRITE_INTERVAL_MS = 1_000;
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
    mkdirSync(join(getAgentDir(), "events"), { recursive: true });
    writePrivateFileAtomicSync(
      channelStatePath(key),
      `${JSON.stringify({ lastEventId: state.lastEventId, seen: state.order.slice(-SEEN_CAP) }, null, 2)}
`,
    );
  } catch {
    // Losing a cursor must not stop the wake-up; the next event rewrites it.
  }
}

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

export function desiredChannels(rules: LoadedRule[]): Map<string, { server: string; workspace: string; projectCwd: string; types: string[]; entityTypes: string[] }> {
  const wanted = new Map<string, { server: string; workspace: string; projectCwd: string; types: string[]; entityTypes: string[] }>();
  for (const rule of rules) {
    const key = channelKey(rule.subscription.server, rule.subscription.workspace);
    const entry = wanted.get(key) ?? {
      server: rule.subscription.server,
      workspace: rule.subscription.workspace,
      projectCwd: rule.projectCwd,
      types: [],
      entityTypes: [],
    };
    entry.types.push(...rule.subscription.filter.events);
    entry.entityTypes.push(...rule.subscription.filter.entityTypes);
    wanted.set(key, entry);
  }
  for (const entry of wanted.values()) {
    entry.types = union(entry.types);
    entry.entityTypes = union(entry.entityTypes);
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
    for (const sessionId of sessionIds) {
      try {
        exists.set(sessionId, Boolean(await resolveSessionPath(sessionId)));
      } catch {
        exists.set(sessionId, false);
      }
    }
    state.sessionExists = exists;

    const wanted = desiredChannels(rules);
    const reshaped = new Set<string>();
    const claimDir = join(getAgentDir(), "events");
    for (const [key, channel] of [...state.channels]) {
      const entry = wanted.get(key);
      const sameShape = entry
        && entry.types.join(",") === channel.types.join(",")
        && entry.entityTypes.join(",") === channel.entityTypes.join(",");
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
  entry: { server: string; workspace: string; projectCwd: string; types: string[]; entityTypes: string[] },
  options: { resume: boolean } = { resume: true },
): Promise<void> {
  const state = runtime();
  const resolved = resolveMcpTarget(getAgentDir(), entry.projectCwd, entry.server);
  if (!resolved.ok) {
    // Reported by the status API from the same resolution, so no connection is
    // registered for a channel that cannot exist.
    return;
  }
  const endpoint = eventEndpointOf(resolved.target.url, resolved.target.headers);
  if (!endpoint) return;

  const cid = await resolveCid(resolved.target, entry.server);
  const claimDir = join(getAgentDir(), "events");
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
      connection: null as unknown as EventConnection,
      state: {
        status: "superseded",
        attempt: 0,
        nextRetryMs: null,
        lastError: ownership.reason,
        connectionId: null,
        gapAt: null,
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
    cid,
    // A widened filter is a new subscription set: replaying it from an old
    // cursor would deliver events that were not relevant when they happened
    // (and read as fresh facts now). Only a reconnect of the same filter resumes.
    lastEventId: options.resume ? loadChannelState(key).lastEventId : null,
    isChannelOwner,
    onEvent: (descriptor, meta) => handleEvent(key, descriptor, meta.id),
    onGap: (info) => {
      const channel = state.channels.get(key);
      if (!channel) return;
      channel.state = {
        ...channel.state,
        gapAt: Date.now(),
        lastError: `这段时间的事件没有投递（gap：${info.reason ?? "unknown"}）`,
      };
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
    connection,
    state: connection.getState(),
  });
  connection.start();
}

function ruleAppliesToChannel(rule: LoadedRule, key: string): boolean {
  return channelKey(rule.subscription.server, rule.subscription.workspace) === key;
}

function handleEvent(key: string, descriptor: EventDescriptor, eventId: string | null): void {
  const state = runtime();
  const channelState = loadChannelState(key);
  if (eventId) channelState.lastEventId = eventId;
  // A frame the previous connection (or the previous process) already handled
  // must not be delivered twice: the injection would be a second, stale wake-up.
  if (!markProcessed(key, descriptor.eventId)) return;
  writeChannelState(key);
  if (!state.channels.has(key)) return;

  for (const rule of state.rules) {
    if (!ruleAppliesToChannel(rule, key)) continue;
    if (rule.subscription.workspace !== descriptor.workspaceId && descriptor.workspaceId) continue;
    if (!matchesSubscription(descriptor, rule.subscription.match)) continue;
    state.coalescer?.add(rule.sessionId, rule.subscription, descriptor);
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

/** One batch into one session, never two at a time (`state.chains`). */
async function deliverNow(batch: CoalescedBatch): Promise<void> {
  const state = runtime();
  const subscription = batch.subscription;

  if (subscription.action !== "wake") {
    // M1 implements `wake` only. A `notify` rule is reported as paused rather
    // than pretending it did something.
    recordDelivery(batch.sessionId, subscription.id, "skipped", "action: notify 属 M2，M1 不投递");
    notifyListeners();
    return;
  }
  if (state.sessionExists.get(batch.sessionId) === false) {
    recordDelivery(batch.sessionId, subscription.id, "skipped", "会话不存在");
    notifyListeners();
    return;
  }

  const { text, subscriptionId } = renderInjection(batch);
  const outcome = await wakeSession(batch.sessionId, text);
  recordDelivery(
    batch.sessionId,
    subscription.id,
    outcome.status === "delivered" ? "delivered" : "skipped",
    outcome.status === "delivered" ? null : `${outcome.reason}（${subscriptionId}）`,
  );
  notifyListeners();
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
  state.coalescer?.dispose();
  state.coalescer = null;
  for (const [key, channel] of state.channels) {
    (channel.connection as EventConnection | null)?.stop?.();
    releaseChannel(join(getAgentDir(), "events"), key);
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
}

export function ruleRuntimeStatus(sessionId: string, subscription: EventSubscription): RuleRuntimeStatus {
  const state = runtime();
  const deliveries = loadSessionDeliveries(sessionId)[subscription.id];
  const key = channelKey(subscription.server, subscription.workspace);
  const channel = state.channels.get(key);
  const today = dayKey(Date.now());
  const todayCount = deliveries && deliveries.day === today ? deliveries.dayCount : 0;

  let blockedReason: string | null = null;
  if (subscription.action !== "wake") blockedReason = "action: notify 属 M2";
  else if (!channel) blockedReason = state.started ? "事件连接尚未建立（或该 server 不可用）" : "事件订阅尚未启动（启动后 2s 惰性连接）";
  else if (channel.state.status === "superseded") blockedReason = channel.state.lastError ?? "另一实例接管了事件连接";
  else if (channel.state.status === "auth_failed") blockedReason = channel.state.lastError ?? "凭据失效";
  else if (channel.state.status === "reconnecting") blockedReason = channel.state.lastError ? `重连中：${channel.state.lastError}` : "重连中";
  else if (channel.state.status === "unavailable") blockedReason = channel.state.lastError ?? "事件通道不可用";

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
        }
      : null,
    blockedReason,
  };
}

export function subscriptionHealthOf(rule: RuleRuntimeStatus, sessionExists: boolean): SubscriptionHealth {
  if (!sessionExists) return "unavailable";
  // Deliberately paused: the rule asked for a response M1 does not implement,
  // or another app instance owns the channel.
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
    }
  }
  return { health, reason };
}

/**
 * The two fields `/api/agent/running` adds (SSR-000097【会话列表标记】).
 * Read from the runtime's last scan; never queries the network.
 */
export function getSubscriptionRuntimeSnapshot(): {
  subscribedSessionIds: string[];
  subscriptionHealth: Record<string, SubscriptionHealth>;
  reasons: Record<string, string | null>;
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
  return { subscribedSessionIds, subscriptionHealth, reasons };
}

/** Where the runtime is, for the status panel's "why is nothing happening". */
export function getEventRuntimeStatus(): {
  started: boolean;
  lastScanAt: number | null;
  lastScanError: string | null;
  channels: { key: string; server: string; workspace: string; state: SubscriptionChannelState }[];
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
      },
    })),
  };
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
