import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// js-yaml 5 ships named exports only (no default), so import the function.
import { load as loadYaml } from "js-yaml";

/**
 * `.pi/events.yaml` — the subscriptions of one project (SSR-000097 SES-EVT).
 *
 * Same directory and style as `.pi/views.yaml`: a file a person reads, edits and
 * commits. One entry per session, one subscription per rule:
 *
 *   version: 1
 *   sessions:
 *     - sessionId: "<id>"
 *       title: "台账巡检编排"          # display only
 *       subscriptions:
 *         - name: "下派项有进展就叫我"   # unique inside the session; part of the id
 *           server: entity-base        # an mcp.json entry — decides the connection and the token
 *           workspace: ws_entity_base
 *           action: wake               # wake (inject → run a turn) | notify (M2)
 *           filter:                    # coarse, server-side
 *             events: [entity.transitioned]
 *             entityTypes: [Task, Item]  # whatever the workspace calls them
 *           match:                     # exact, client-side, on the normalized envelope
 *             to: [BLOCKED, FINISHED]
 *           coalesceSec: 30
 *           maxPerHour: 20
 *           inject: |
 *             [事件] {{count}} 条变化（{{window}}s 内合批）：
 *             {{events}}
 *
 * The file is the *intent*. Runtime facts (last event id, delivered counters)
 * live in `~/.pi/agent/subscriptions/<sessionId>.json`, never here.
 */

/** Keys `filter:` may contain — exactly the dimensions the base server can filter on. */
export const FILTER_KEYS = ["events", "entityTypes", "operator", "linkTypes", "custom"] as const;

/**
 * Keys one `subscriptions:` item may contain — a closed set.
 *
 * There is deliberately no "ignore what we do not know" branch: a misspelt key
 * (`selfQuiet: 15`, `coalesce_sec: 5`, `max_per_hour: 5`) used to be read as
 * "absent", so the rule validated, the field vanished, and the guard a person
 * thought they had configured was air (the M1 failure mode this closes).
 */
export const SUBSCRIPTION_KEYS = [
  "name",
  "server",
  "workspace",
  "action",
  "filter",
  "match",
  "inject",
  "coalesceSec",
  "maxPerHour",
  "recheck",
  "selfQuietSec",
  "loopWindowSec",
  "loopMaxHits",
] as const;

/** Keys one `sessions:` item may contain. `storm*` belongs to the session: the fuse pauses every rule of it. */
export const SESSION_KEYS = [
  "sessionId",
  "title",
  "subscriptions",
  "stormWindowSec",
  "stormMaxDeliveries",
] as const;

/** Keys the document root may contain. */
export const ROOT_KEYS = ["version", "sessions"] as const;

/**
 * Keys `match:` may contain — the normalized descriptor, never a key.
 *
 * `filter` cannot carry a state (the server silently ignores it, SSR-000097
 * 【基座现状】); `match` cannot carry `key` (the envelope only has an id). Both
 * refusals are errors, not silent drops: a rule that reads as if it filtered is
 * the failure mode this feature cannot afford.
 */
export const MATCH_KEYS = ["eventType", "aggregateType", "from", "to", "changedFields", "operator"] as const;

/** Placeholders an `inject:` template may use. An unknown one is a configuration error. */
export const INJECT_PLACEHOLDERS = [
  "count",
  "window",
  "events",
  "aggregateType",
  "aggregateId",
  "workspaceId",
  "timestamp",
  "operator",
  "from",
  "to",
  "hitCount",
] as const;

export type InjectPlaceholder = (typeof INJECT_PLACEHOLDERS)[number];

export interface SubscriptionFilter {
  events: string[];
  entityTypes: string[];
  operator: string | null;
  linkTypes: string[];
  custom: boolean | null;
}

/** Every match value is a list (a single string in the file is one-element). `["*"]` = any. */
export type MatchPredicate = string[];

export interface SubscriptionMatch {
  eventType: MatchPredicate | null;
  aggregateType: MatchPredicate | null;
  from: MatchPredicate | null;
  to: MatchPredicate | null;
  changedFields: MatchPredicate | null;
  operator: MatchPredicate | null;
}

export type SubscriptionAction = "wake" | "notify";

export interface EventSubscription {
  /** `${sessionId}#${name}` — stable across edits of the rule, printed on the injection's first line. */
  id: string;
  name: string;
  server: string;
  workspace: string;
  action: SubscriptionAction;
  filter: SubscriptionFilter;
  match: SubscriptionMatch;
  coalesceSec: number;
  /** Delivered wake-ups allowed in a rolling hour; the next one is `skipped:limited`. */
  maxPerHour: number;
  /** Re-read each aggregate before delivering; a hit that no longer matches is `skipped:stale`. */
  recheck: boolean;
  /** Quiet period after a delivery of this rule, in seconds (`0` disables). */
  selfQuietSec: number;
  /** Rolling window of the per-aggregate loop fuse, in seconds. */
  loopWindowSec: number;
  /** Deliveries of one aggregate allowed inside `loopWindowSec`; the next one is `skipped:loop`. */
  loopMaxHits: number;
  /** Session-wide storm fuse window (inherited from the `sessions:` item). */
  stormWindowSec: number;
  /** Session-wide deliveries inside the window that pause every rule of the session. */
  stormMaxDeliveries: number;
  /** The template, or null when the rule uses the built-in one. */
  inject: string | null;
}

export interface SubscriptionEntry {
  /** Readable label even when the entry is broken: `#2 "下派项有进展就叫我"`. */
  label: string;
  error: string | null;
  subscription: EventSubscription | null;
}

export interface SessionSubscriptions {
  sessionId: string;
  title: string | null;
  error: string | null;
  subscriptions: SubscriptionEntry[];
  stormWindowSec: number;
  stormMaxDeliveries: number;
}

export interface EventsConfig {
  path: string;
  exists: boolean;
  /** Why the file as a whole cannot be used (bad YAML, wrong root shape). */
  error: string | null;
  sessions: SessionSubscriptions[];
}

export const EVENTS_CONFIG_RELATIVE_PATHS = [
  join(".pi", "events.yaml"),
  join(".pi", "events.yml"),
  "events.yaml",
  "events.yml",
] as const;

export const DEFAULT_COALESCE_SEC = 30;
export const DEFAULT_MAX_PER_HOUR = 20;
export const DEFAULT_SELF_QUIET_SEC = 15;
export const DEFAULT_LOOP_WINDOW_SEC = 300;
export const DEFAULT_LOOP_MAX_HITS = 3;
export const DEFAULT_STORM_WINDOW_SEC = 600;
export const DEFAULT_STORM_MAX_DELIVERIES = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A list of names, or `"*"` (kept as `["*"]`). Anything else is a problem named
 * by the caller's field prefix.
 */
function readPredicate(raw: unknown, field: string, problems: string[]): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) problems.push(`${field} 是空字符串`);
    return text ? [text] : null;
  }
  if (!Array.isArray(raw)) {
    problems.push(`${field} 只能是数组或 "*"（写的是 ${JSON.stringify(raw)}）`);
    return null;
  }
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      problems.push(`${field} 的每一项都必须是字符串（写的是 ${JSON.stringify(item)}）`);
      continue;
    }
    values.push(item.trim());
  }
  return values.length > 0 ? values : null;
}

function readStringList(raw: unknown, field: string, problems: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) {
    problems.push(`${field} 只能是数组（写的是 ${JSON.stringify(raw)}）`);
    return [];
  }
  const values: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      problems.push(`${field} 的每一项都必须是字符串（写的是 ${JSON.stringify(item)}）`);
      continue;
    }
    values.push(item.trim());
  }
  return values;
}

function readFilter(raw: unknown, problems: string[]): SubscriptionFilter {
  if (raw === undefined || raw === null) {
    return { events: [], entityTypes: [], operator: null, linkTypes: [], custom: null };
  }
  if (!isRecord(raw)) {
    problems.push("filter 必须是对象（events / entityTypes / operator / linkTypes / custom）");
    return { events: [], entityTypes: [], operator: null, linkTypes: [], custom: null };
  }
  const filter: SubscriptionFilter = {
    events: [],
    entityTypes: [],
    operator: null,
    linkTypes: [],
    custom: null,
  };
  for (const key of Object.keys(raw)) {
    if (!(FILTER_KEYS as readonly string[]).includes(key)) {
      // The base server has no such dimension. `state` is the one people reach
      // for: it would be silently ignored and the rule would look configured.
      problems.push(
        key === "state"
          ? "filter.state：服务端不支持按状态过滤（会被静默忽略），请把状态写进 match"
          : `filter.${key}：filter 只接受 ${FILTER_KEYS.join(" / ")}`,
      );
      continue;
    }
    switch (key) {
      case "events":
        filter.events = readStringList(raw.events, "filter.events", problems);
        break;
      case "entityTypes":
        filter.entityTypes = readStringList(raw.entityTypes, "filter.entityTypes", problems);
        break;
      case "linkTypes":
        filter.linkTypes = readStringList(raw.linkTypes, "filter.linkTypes", problems);
        break;
      case "operator":
        if (typeof raw.operator !== "string" || !raw.operator.trim()) {
          problems.push(`filter.operator 必须是非空字符串（写的是 ${JSON.stringify(raw.operator)}）`);
        } else {
          filter.operator = raw.operator.trim();
        }
        break;
      case "custom":
        if (typeof raw.custom !== "boolean") {
          problems.push(`filter.custom 只能是 true 或 false（写的是 ${JSON.stringify(raw.custom)}）`);
        } else {
          filter.custom = raw.custom;
        }
        break;
    }
  }
  return filter;
}

function readMatch(raw: unknown, problems: string[]): SubscriptionMatch {
  const match: SubscriptionMatch = {
    eventType: null,
    aggregateType: null,
    from: null,
    to: null,
    changedFields: null,
    operator: null,
  };
  if (raw === undefined || raw === null) return match;
  if (!isRecord(raw)) {
    problems.push("match 必须是对象（eventType / aggregateType / from / to / changedFields / operator）");
    return match;
  }
  for (const key of Object.keys(raw)) {
    if (!(MATCH_KEYS as readonly string[]).includes(key)) {
      problems.push(
        key === "key"
          ? "match.key：事件信封里只有 aggregateId，没有 key；请用 recheck 或让模型去读"
          : `match.${key}：match 只接受 ${MATCH_KEYS.join(" / ")}`,
      );
      continue;
    }
    const values = readPredicate(raw[key], `match.${key}`, problems);
    if (values) match[key as keyof SubscriptionMatch] = values;
  }
  return match;
}

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Unknown placeholders are refused: rendering them as an empty string hides the mistake. */
export function findUnknownPlaceholders(template: string): string[] {
  const known = new Set<string>(INJECT_PLACEHOLDERS);
  const unknown: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (!known.has(name) && !unknown.includes(name)) unknown.push(name);
  }
  return unknown;
}

function positiveInt(raw: unknown, fallback: number, field: string, problems: string[]): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    problems.push(`${field} 必须是正整数（写的是 ${JSON.stringify(raw)}）`);
    return fallback;
  }
  return parsed;
}

/** `0` is meaningful here: it switches the fuse off, which is said in the error text. */
function nonNegativeInt(raw: unknown, fallback: number, field: string, problems: string[]): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) {
    problems.push(`${field} 必须是 ≥0 的整数（写的是 ${JSON.stringify(raw)}；0 表示关闭这道保险丝）`);
    return fallback;
  }
  return parsed;
}

function readBoolean(raw: unknown, fallback: boolean, field: string, problems: string[]): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "boolean") {
    problems.push(`${field} 只能是 true 或 false（写的是 ${JSON.stringify(raw)}）`);
    return fallback;
  }
  return raw;
}

/** Every unknown key is an error: silently dropping one hides a guard the author meant to configure. */
function rejectUnknownKeys(raw: Record<string, unknown>, allowed: readonly string[], where: string, problems: string[]): void {
  for (const key of Object.keys(raw)) {
    if ((allowed as readonly string[]).includes(key)) continue;
    problems.push(`${where}${key}：未知配置项（只接受 ${allowed.join(" / ")}）`);
  }
}

/** One list item of `subscriptions:`; a broken rule never fails the others. */
function parseSubscription(
  raw: unknown,
  index: number,
  sessionId: string,
  storm: { stormWindowSec: number; stormMaxDeliveries: number },
): { entry: SubscriptionEntry; problems: string[] } {
  const ordinal = `#${index + 1}`;
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return { entry: { label: ordinal, error: `订阅 ${ordinal} 不是对象`, subscription: null }, problems: [`订阅 ${ordinal} 不是对象`] };
  }
  const name = asText(raw.name);
  const label = name ? `${ordinal} "${name}"` : ordinal;
  const fail = (message: string): { entry: SubscriptionEntry; problems: string[] } => {
    problems.push(`订阅 ${label}：${message}`);
    return { entry: { label, error: message, subscription: null }, problems };
  };

  rejectUnknownKeys(raw, SUBSCRIPTION_KEYS, "订阅级 ", problems);

  if (!name) return fail("缺少 name（它是注入首行的标识，必须写）");
  if (name.includes("#")) return fail("name 不能包含 #（id 由 sessionId#name 组成）");

  const server = asText(raw.server);
  if (!server) return fail("缺少 server（mcp.json 里的条目名）");
  const workspace = asText(raw.workspace);
  if (!workspace) return fail("缺少 workspace");

  let action: SubscriptionAction = "wake";
  if (raw.action !== undefined && raw.action !== null) {
    const text = asText(raw.action).toLowerCase();
    if (text === "wake" || text === "notify") action = text;
    else return fail(`action 只能是 wake 或 notify（写的是 ${JSON.stringify(raw.action)}）`);
  }

  const filter = readFilter(raw.filter, problems);
  const match = readMatch(raw.match, problems);

  let inject: string | null = null;
  if (raw.inject !== undefined && raw.inject !== null) {
    if (typeof raw.inject !== "string" || !raw.inject.trim()) {
      problems.push("inject 必须是非空字符串（可以省略，用内置模板）");
    } else {
      const unknown = findUnknownPlaceholders(raw.inject);
      if (unknown.length > 0) {
        problems.push(
          `inject 里的占位符 ${unknown.map((name) => `{{${name}}}`).join("、")} 未声明；可用：${INJECT_PLACEHOLDERS.map((name) => `{{${name}}}`).join(" ")}`,
        );
      } else {
        inject = raw.inject;
      }
    }
  }

  const coalesceSec = positiveInt(raw.coalesceSec, DEFAULT_COALESCE_SEC, "coalesceSec", problems);
  const maxPerHour = positiveInt(raw.maxPerHour, DEFAULT_MAX_PER_HOUR, "maxPerHour", problems);
  const recheck = readBoolean(raw.recheck, false, "recheck", problems);
  const selfQuietSec = nonNegativeInt(raw.selfQuietSec, DEFAULT_SELF_QUIET_SEC, "selfQuietSec", problems);
  const loopWindowSec = positiveInt(raw.loopWindowSec, DEFAULT_LOOP_WINDOW_SEC, "loopWindowSec", problems);
  // 1 would refuse every delivery of an aggregate after the first one, which is
  // a quota, not a fuse; the hourly quota is `maxPerHour`.
  const loopMaxHits = positiveInt(raw.loopMaxHits, DEFAULT_LOOP_MAX_HITS, "loopMaxHits", problems);

  if (problems.length > 0) return fail(problems.join("；"));

  return {
    entry: {
      label,
      error: null,
      subscription: {
        id: `${sessionId}#${name}`,
        name,
        server,
        workspace,
        action,
        filter,
        match,
        coalesceSec,
        maxPerHour,
        recheck,
        selfQuietSec,
        loopWindowSec,
        loopMaxHits,
        stormWindowSec: storm.stormWindowSec,
        stormMaxDeliveries: storm.stormMaxDeliveries,
        inject,
      },
    },
    problems: [],
  };
}

function parseSession(raw: unknown, index: number): SessionSubscriptions {
  const ordinal = `#${index + 1}`;
  if (!isRecord(raw)) {
    return {
      sessionId: `#${index + 1}`,
      title: null,
      error: `sessions 第 ${index + 1} 项不是对象`,
      subscriptions: [],
      stormWindowSec: DEFAULT_STORM_WINDOW_SEC,
      stormMaxDeliveries: DEFAULT_STORM_MAX_DELIVERIES,
    };
  }
  const sessionId = asText(raw.sessionId);
  const title = asText(raw.title) || null;
  if (!sessionId) {
    return {
      sessionId: ordinal,
      title,
      error: `sessions 第 ${index + 1} 项缺少 sessionId`,
      subscriptions: [],
      stormWindowSec: DEFAULT_STORM_WINDOW_SEC,
      stormMaxDeliveries: DEFAULT_STORM_MAX_DELIVERIES,
    };
  }

  const rawSubscriptions = raw.subscriptions;
  if (!Array.isArray(rawSubscriptions) || rawSubscriptions.length === 0) {
    return {
      sessionId,
      title,
      error: "订阅为空：subscriptions 必须是非空数组",
      subscriptions: [],
      stormWindowSec: DEFAULT_STORM_WINDOW_SEC,
      stormMaxDeliveries: DEFAULT_STORM_MAX_DELIVERIES,
    };
  }

  const problems: string[] = [];
  // A problem in the `sessions:` item itself (an unknown key, a bad storm value)
  // makes every rule of that session unusable: the alternative is a rule that
  // looks configured while the setting it names was read as absent.
  const sessionProblems: string[] = [];
  rejectUnknownKeys(raw, SESSION_KEYS, "会话级 ", sessionProblems);
  const stormWindowSec = positiveInt(raw.stormWindowSec, DEFAULT_STORM_WINDOW_SEC, "stormWindowSec", sessionProblems);
  const stormMaxDeliveries = positiveInt(
    raw.stormMaxDeliveries,
    DEFAULT_STORM_MAX_DELIVERIES,
    "stormMaxDeliveries",
    sessionProblems,
  );
  const subscriptions = rawSubscriptions.map((item, position) => {
    const parsed = parseSubscription(item, position, sessionId, { stormWindowSec, stormMaxDeliveries });
    problems.push(...parsed.problems);
    return parsed.entry;
  });

  if (sessionProblems.length > 0) {
    const message = sessionProblems.join("；");
    problems.push(message);
    for (const entry of subscriptions) {
      entry.subscription = null;
      entry.error = entry.error ? `${entry.error}；${message}` : message;
    }
  }

  // Two rules with one name share an id, so the injection's first line could not
  // say which rule woke the session.
  const seen = new Set<string>();
  for (const entry of subscriptions) {
    if (!entry.subscription) continue;
    const name = entry.subscription.name.toLowerCase();
    if (seen.has(name)) {
      entry.error = `name 重复："${entry.subscription.name}"`;
      entry.subscription = null;
      problems.push(`订阅 ${entry.label}：name 重复，必须唯一`);
    } else {
      seen.add(name);
    }
  }

  return {
    sessionId,
    title,
    error: problems.length > 0 ? problems.join("；") : null,
    subscriptions,
    stormWindowSec,
    stormMaxDeliveries,
  };
}

/** Reads and validates `<cwd>/.pi/events.yaml`. Never throws: problems come back as text. */
export function readEventsConfig(cwd: string): EventsConfig {
  const candidates = EVENTS_CONFIG_RELATIVE_PATHS.map((relative) => ({
    relative,
    absolute: join(cwd, relative),
  }));
  const found = candidates.find((candidate) => existsSync(candidate.absolute));
  if (!found) {
    return { path: candidates[0].absolute, exists: false, error: null, sessions: [] };
  }

  let text: string;
  try {
    text = readFileSync(found.absolute, "utf8");
  } catch (error) {
    return { path: found.absolute, exists: true, error: `读取失败：${error instanceof Error ? error.message : String(error)}`, sessions: [] };
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(text);
  } catch (error) {
    return { path: found.absolute, exists: true, error: `YAML 解析失败：${error instanceof Error ? error.message : String(error)}`, sessions: [] };
  }

  if (!isRecord(parsed)) {
    return { path: found.absolute, exists: true, error: "根节点必须是对象，形如 sessions: [...]", sessions: [] };
  }

  if (parsed.version !== undefined && parsed.version !== null && parsed.version !== 1) {
    return { path: found.absolute, exists: true, error: `version 只支持 1（写的是 ${JSON.stringify(parsed.version)}）`, sessions: [] };
  }

  const unknownRoot = Object.keys(parsed).filter((key) => !(ROOT_KEYS as readonly string[]).includes(key));
  if (unknownRoot.length > 0) {
    return {
      path: found.absolute,
      exists: true,
      error: `根节点只接受 ${ROOT_KEYS.join(" / ")}（多余的是 ${unknownRoot.join("、")}）`,
      sessions: [],
    };
  }

  const rawSessions = parsed.sessions;
  if (!Array.isArray(rawSessions)) {
    return { path: found.absolute, exists: true, error: "缺少 sessions 数组（sessions: [...]）", sessions: [] };
  }

  const sessions = rawSessions.map((raw, index) => parseSession(raw, index));

  // One session id, one entry: two entries would each hold half the rules and
  // the status view could not say which is in effect.
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.sessionId)) {
      session.error = `${session.error ? `${session.error}；` : ""}sessionId 重复："${session.sessionId}"`;
      session.subscriptions = [];
    } else {
      seen.add(session.sessionId);
    }
  }

  return { path: found.absolute, exists: true, error: null, sessions };
}

/** Every usable rule across the file, with its session id attached. */
export interface LoadedSubscription {
  sessionId: string;
  title: string | null;
  subscription: EventSubscription;
}

export function usableSubscriptions(config: EventsConfig): LoadedSubscription[] {
  const loaded: LoadedSubscription[] = [];
  for (const session of config.sessions) {
    for (const entry of session.subscriptions) {
      if (!entry.subscription) continue;
      loaded.push({ sessionId: session.sessionId, title: session.title, subscription: entry.subscription });
    }
  }
  return loaded;
}
