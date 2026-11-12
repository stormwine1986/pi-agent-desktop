/**
 * The delivery gates of SSR-000097【流水线】⑤ — quota, quiet period, loop fuse,
 * storm fuse — as pure functions over timestamps.
 *
 * The order is part of the design, not an implementation detail: **coalesce
 * first, then recheck, then the gates** (the caller does the first two). Counting
 * before coalescing would charge one entity's burst (`→ A`, `→ B`, `→ A` in one
 * window) three times against `maxPerHour`, so a rule that fires once would be
 * reported as over quota.
 *
 * Every gate records *why* it refused (`skipped:self` / `skipped:loop` /
 * `skipped:limited`) — a wake-up that silently does not happen is the failure
 * mode this whole feature exists to avoid.
 */

export type GateSkipReason = "self" | "limited" | "loop";

export interface GateVerdict {
  skip: GateSkipReason | null;
  /** Human-readable reason, written to `lastReason` as `skipped:<reason>：<detail>`. */
  detail: string;
}

/** The last `windowSec` seconds of a timestamp list. Timestamps are epoch ms. */
export function withinWindow(times: readonly number[], now: number, windowSec: number): number[] {
  if (windowSec <= 0) return [];
  const from = now - windowSec * 1000;
  return times.filter((time) => time > from && time <= now);
}

/** Rolling-hour quota: `maxPerHour` deliveries, the next one is refused. */
export function quotaExhausted(deliveredInHour: readonly number[], now: number, maxPerHour: number): boolean {
  return withinWindow(deliveredInHour, now, 3600).length >= maxPerHour;
}

/**
 * `selfQuietSec`: the time still to wait after the last delivery of this rule.
 * `0` disables the fuse (an explicit choice, not a default).
 */
export function quietRemainingMs(lastDeliveredAt: number | null, now: number, selfQuietSec: number): number {
  if (selfQuietSec <= 0 || lastDeliveredAt === null) return 0;
  const elapsed = now - lastDeliveredAt;
  const windowMs = selfQuietSec * 1000;
  return elapsed >= windowMs ? 0 : windowMs - elapsed;
}

/**
 * Loop fuse: one aggregate may be delivered `loopMaxHits` times inside
 * `loopWindowSec`; the next delivery that touches it is refused. Returning the
 * aggregate id lets the reason name the entity instead of saying "something".
 */
export function loopExhausted(
  hits: readonly { aggregateId: string }[],
  aggregateDeliveries: Readonly<Record<string, readonly number[]>>,
  now: number,
  loopWindowSec: number,
  loopMaxHits: number,
): { blocked: string | null; count: number } {
  for (const hit of hits) {
    const times = withinWindow(aggregateDeliveries[hit.aggregateId] ?? [], now, loopWindowSec);
    if (times.length >= loopMaxHits) return { blocked: hit.aggregateId, count: times.length };
  }
  return { blocked: null, count: 0 };
}

export interface GateInput {
  now: number;
  selfQuietSec: number;
  lastDeliveredAt: number | null;
  /** Delivery timestamps of this rule (any age; pruned here). */
  delivered: readonly number[];
  maxPerHour: number;
  loopWindowSec: number;
  loopMaxHits: number;
  /** Delivery timestamps per aggregate id, for this rule. */
  aggregateDeliveries: Readonly<Record<string, readonly number[]>>;
  /** The hits that survived recheck. */
  hits: readonly { aggregateId: string }[];
}

/**
 * The three gates, in the order the reason should be reported: the quiet period
 * is the cheapest and the most local, the hourly quota is what a person checks
 * first when nothing happens, the loop fuse names a specific entity.
 */
export function evaluateGates(input: GateInput): GateVerdict {
  const quietMs = quietRemainingMs(input.lastDeliveredAt, input.now, input.selfQuietSec);
  if (quietMs > 0) {
    const seconds = Math.ceil(quietMs / 1000);
    return { skip: "self", detail: `距上次投递不足 ${input.selfQuietSec}s（还剩 ${seconds}s）` };
  }

  if (quotaExhausted(input.delivered, input.now, input.maxPerHour)) {
    return { skip: "limited", detail: `一小时内已投递 ${input.maxPerHour} 次（maxPerHour）` };
  }

  const loop = loopExhausted(input.hits, input.aggregateDeliveries, input.now, input.loopWindowSec, input.loopMaxHits);
  if (loop.blocked !== null) {
    return {
      skip: "loop",
      detail: `${loop.blocked} 在 ${input.loopWindowSec}s 内已投递 ${loop.count} 次（上限 ${input.loopMaxHits}）`,
    };
  }

  return { skip: null, detail: "" };
}

/** Delivered now: adds the stamp to the rule history and to every hit's aggregate history. */
export function recordGateDelivery(
  delivered: readonly number[],
  aggregateDeliveries: Readonly<Record<string, readonly number[]>>,
  hits: readonly { aggregateId: string }[],
  now: number,
): { delivered: number[]; aggregateDeliveries: Record<string, number[]> } {
  const nextDelivered = [...delivered, now].slice(-200);
  const nextAggregate: Record<string, number[]> = {};
  for (const [id, times] of Object.entries(aggregateDeliveries)) nextAggregate[id] = [...times];
  // One batch carries one entry per aggregate, and a batch is charged once: a
  // duplicated id inside `hits` must not become a second stamp (the whole point
  // of "coalesce before limiting").
  for (const aggregateId of new Set(hits.map((hit) => hit.aggregateId))) {
    nextAggregate[aggregateId] = [...(nextAggregate[aggregateId] ?? []), now].slice(-50);
  }
  return { delivered: nextDelivered, aggregateDeliveries: nextAggregate };
}

export interface StormVerdict {
  tripped: boolean;
  count: number;
}

/**
 * Session storm fuse: `stormMaxDeliveries` deliveries inside `stormWindowSec`
 * pause every subscription of that session. The caller *delivers* the batch that
 * reaches the threshold, then pauses — "≥ N" is the trigger, not "N + 1".
 */
export function stormReached(
  sessionDeliveries: readonly number[],
  now: number,
  stormWindowSec: number,
  stormMaxDeliveries: number,
): StormVerdict {
  const count = withinWindow(sessionDeliveries, now, stormWindowSec).length;
  return { tripped: count >= stormMaxDeliveries, count };
}
