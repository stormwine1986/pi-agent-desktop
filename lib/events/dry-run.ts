import type { EventSubscription, SubscriptionMatch } from "./config";
import { matchesSubscription, matchesValue, type EventDescriptor } from "./match";

/**
 * "Would this rule have fired on the events this channel has seen?" — the
 * panel's dry run (M3 / AC-4).
 *
 * Three things this must not do, because each would make the answer useless:
 *
 * 1. **deliver** anything, or touch a counter — it is a read: the caller passes
 *    a snapshot of the channel's recent frames and gets a verdict back;
 * 2. **answer "no match"**. Every miss names the rule field that decided it
 *    (`match.to = [FINISHED]`, the event's `to` was `IN_PROGRESS`), because the
 *    person is editing *those* fields;
 * 3. **lie about which stage filters.** The server only knows the union of the
 *    channel's `filter:` blocks; a rule's own `filter:` is never applied again
 *    on the client. So the coarse stage is judged against the union, and a rule
 *    whose own filter is narrower than that says so explicitly.
 */

export interface DryRunEvent {
  descriptor: EventDescriptor;
  /** When this process received it (epoch ms). */
  receivedAt: number;
  /** It was replayed after a reconnect (`lib/events/catch-up.ts`). */
  catchUp: boolean;
}

/** The server-side filter of a whole `(server, workspace)` channel. */
export interface ChannelCoarseFilter {
  events: string[];
  entityTypes: string[];
}

export interface DryRunVerdict {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  key: string | null;
  from: string | null;
  to: string | null;
  operator: string;
  timestamp: string;
  receivedAt: number;
  catchUp: boolean;
  hit: boolean;
  /** Which stage refused it: the server's coarse filter, or this rule's `match:`. */
  stage: "filter" | "match" | null;
  /** One line per deciding field, quoting the rule and the event. */
  reasons: string[];
}

export interface DryRunGate {
  /** The storm fuse of this session, in words. */
  pausedReason: string | null;
  lastWakeAt: number | null;
  hourlyCount: number;
  maxPerHour: number;
  selfQuietSec: number;
  /** Whether the session is running a turn right now (a `wake` batch would be parked). */
  running: boolean;
}

export interface SubscriptionWarning {
  code: "self-excitation";
  message: string;
}

export interface DryRunResult {
  evaluated: number;
  hits: DryRunVerdict[];
  misses: DryRunVerdict[];
  /** Why a hit would still not arrive right now (quota, quiet period, pause). */
  blockedBy: string | null;
  /** Why a hit would arrive late (the session is mid-turn → `pendingBatch`). */
  delayedBy: string | null;
  warnings: SubscriptionWarning[];
}

const CREATION_EVENTS = ["entity.created", "entity.updated"];

function listOf(values: string[] | null | undefined): string {
  return values && values.length > 0 ? `[${values.join(", ")}]` : "未写（任意）";
}

function shown(value: string | null): string {
  return value === null ? "null" : value;
}

/** Does the coarse filter of the *channel* admit this frame? Empty dimension = no restriction. */
function coarseAdmits(descriptor: EventDescriptor, coarse: ChannelCoarseFilter): string[] {
  const reasons: string[] = [];
  if (coarse.events.length > 0 && !coarse.events.some((type) => type === descriptor.eventType || type === "*" || (type.endsWith(".*") && descriptor.eventType.startsWith(`${type.slice(0, -1)}`)))) {
    reasons.push(`事件类型 ${descriptor.eventType} 不在服务端粗筛（本 channel 的 filter.events 并集 ${listOf(coarse.events)}）`);
  }
  if (coarse.entityTypes.length > 0 && !coarse.entityTypes.some((type) => type === descriptor.aggregateType || type === "*")) {
    reasons.push(`实体类型 ${descriptor.aggregateType} 不在 filter.entityTypes 并集 ${listOf(coarse.entityTypes)}`);
  }
  return reasons;
}

/**
 * Every `match:` field, in the order the loader declares them, with the value the
 * event actually carried. A miss quotes both sides.
 */
function matchReasons(descriptor: EventDescriptor, match: SubscriptionMatch): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const check = (field: keyof SubscriptionMatch, value: string | null, carried: string): void => {
    const predicate = match[field];
    if (!predicate || predicate.length === 0 || predicate.includes("*")) {
      lines.push(`match.${field} ${listOf(predicate)}，事件的 ${field} 是 ${carried}`);
      return;
    }
    if (!matchesValue(predicate, value)) {
      ok = false;
      lines.push(`match.${field} = ${listOf(predicate)}，事件的 ${field} 是 ${carried}`);
      return;
    }
    lines.push(`命中 match.${field}：事件的 ${field} = ${carried} 在 ${listOf(predicate)} 里`);
  };

  check("eventType", descriptor.eventType, descriptor.eventType);
  check("aggregateType", descriptor.aggregateType, descriptor.aggregateType);
  check("from", descriptor.from, shown(descriptor.from));
  check("to", descriptor.to, shown(descriptor.to));
  check("operator", descriptor.operator, shown(descriptor.operator || null));
  const changed = match.changedFields;
  if (!changed || changed.length === 0 || changed.includes("*")) {
    lines.push(`match.changedFields ${listOf(changed)}，事件变动的字段是 [${descriptor.changedFields.join(", ")}]`);
  } else if (!descriptor.changedFields.some((field) => changed.includes(field))) {
    ok = false;
    lines.push(`match.changedFields = ${listOf(changed)}，事件变动的字段是 [${descriptor.changedFields.join(", ")}]（没有交集）`);
  } else {
    lines.push(`命中 match.changedFields：事件变动的字段 [${descriptor.changedFields.join(", ")}] 与 ${listOf(changed)} 有交集`);
  }
  return { ok, lines };
}

/**
 * Self-excitation (M3 / AC-5): a `wake` rule on a creation/update event
 * will be woken by the very entities the woken session creates or updates. It is
 * a **warning**, never a refusal — the file still loads and still runs; the
 * narrowings in `match` are what the message asks for, and configuring one makes
 * it disappear.
 */
export function selfExcitationWarning(rule: EventSubscription): SubscriptionWarning | null {
  if (rule.action !== "wake") return null;
  const names = new Set<string>();
  const named = [...rule.filter.events, ...(rule.match.eventType ?? [])];
  for (const type of named) {
    if (CREATION_EVENTS.includes(type)) names.add(type);
    else if (type === "*" || type === "entity.*") for (const each of CREATION_EVENTS) names.add(each);
  }
  // `match.eventType` can also narrow creation away: a concrete list that does
  // not name it means the frame never reaches the rule's own match.
  const allowedByEventType = [...names].filter((type) => matchesValue(rule.match.eventType, type));
  names.clear();
  for (const type of allowedByEventType) names.add(type);
  if (names.size === 0) return null;
  // A concrete state predicate narrows creation/update events away: creation
  // carries the new state in `to`, an update carries no state pair at all, so a
  // rule that only fires for a state it reacts to cannot be woken by its own
  // writes.
  const narrowed = (predicate: string[] | null): boolean =>
    Boolean(predicate && predicate.length > 0 && !predicate.includes("*"));
  if (narrowed(rule.match.to) || narrowed(rule.match.from)) return null;

  const listed = [...names].join(" / ");
  return {
    code: "self-excitation",
    message:
      `自激风险：这条规则订阅了 ${listed} 且 action: wake —— 会话自己派发时写出的实体也会命中，` +
      `于是它把自己叫醒。收窄 match.to / match.from（只订阅真正需要你决策的状态）后这条警告消失；` +
      `只想提醒不想跑一轮就把 action 改成 notify。`,
  };
}

export function dryRunSubscription(
  rule: EventSubscription,
  events: DryRunEvent[],
  coarse: ChannelCoarseFilter,
  gate: DryRunGate,
  now = Date.now(),
): DryRunResult {
  const hits: DryRunVerdict[] = [];
  const misses: DryRunVerdict[] = [];

  for (const event of events) {
    const descriptor = event.descriptor;
    const verdict: DryRunVerdict = {
      eventId: descriptor.eventId,
      eventType: descriptor.eventType,
      aggregateType: descriptor.aggregateType,
      aggregateId: descriptor.aggregateId,
      key: descriptor.key,
      from: descriptor.from,
      to: descriptor.to,
      operator: descriptor.operator,
      timestamp: descriptor.timestamp,
      receivedAt: event.receivedAt,
      catchUp: event.catchUp,
      hit: false,
      stage: null,
      reasons: [],
    };

    const coarseReasons = coarseAdmits(descriptor, coarse);
    if (coarseReasons.length > 0) {
      verdict.stage = "filter";
      verdict.reasons = [
        ...coarseReasons,
        `本规则的 filter.events = ${listOf(rule.filter.events)}、filter.entityTypes = ${listOf(rule.filter.entityTypes)}；` +
          `运行时不按本规则的 filter 再筛一次，服务端只上送并集`,
      ];
      misses.push(verdict);
      continue;
    }

    const matched = matchReasons(descriptor, rule.match);
    verdict.hit = matched.ok && matchesSubscription(descriptor, rule.match);
    verdict.stage = verdict.hit ? null : "match";
    verdict.reasons = matched.lines;
    (verdict.hit ? hits : misses).push(verdict);
  }

  let blockedBy: string | null = null;
  if (gate.pausedReason) {
    blockedBy = `会话的订阅已被风暴保险丝暂停：${gate.pausedReason}`;
  } else if (gate.hourlyCount >= gate.maxPerHour) {
    blockedBy = `本规则一小时内已投递 ${gate.hourlyCount} 次（maxPerHour: ${gate.maxPerHour}），下一批会记 skipped:limited`;
  } else if (gate.lastWakeAt !== null && gate.selfQuietSec > 0) {
    const elapsed = Math.max(0, Math.round((now - gate.lastWakeAt) / 1000));
    if (elapsed < gate.selfQuietSec) {
      blockedBy = `距本规则上次投递 ${elapsed}s，不足 selfQuietSec: ${gate.selfQuietSec}，这一批会记 skipped:self`;
    }
  }

  const delayedBy = !blockedBy && gate.running && rule.action === "wake"
    ? "会话正在跑一轮：这一批会进 pendingBatch，本轮结束后投递一次（不会插话）"
    : null;

  const warning = selfExcitationWarning(rule);
  return {
    evaluated: events.length,
    hits,
    misses,
    blockedBy,
    delayedBy,
    warnings: warning ? [warning] : [],
  };
}

/** One line for the panel: what the dry run saw, in a sentence. */
export function describeDryRun(result: DryRunResult): string {
  if (result.evaluated === 0) {
    return "最近的事件缓冲里还没有事件（运行时每接一条就记一条；等有变化后再试运行）。";
  }
  return `缓冲里 ${result.evaluated} 条事件：命中 ${result.hits.length} 条，未命中 ${result.misses.length} 条。`;
}
