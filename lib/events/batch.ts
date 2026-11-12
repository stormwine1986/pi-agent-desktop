import type { EventSubscription } from "./config";
import type { EventDescriptor } from "./match";

/**
 * Client-side coalescing window (SSR-000097【流水线】④).
 *
 * The server's `coalesce` flag is *not* a time window — it replaces a queued
 * frame for the same aggregate only when the queue overflows — so the rule's
 * `coalesceSec` is implemented here. Within one window:
 *
 * - the same aggregate joins the entry it already has (`hitCount += 1`, latest
 *   `from`/`to` win) — "连转两次只注入一次";
 * - different aggregates become separate entries of the *same* batch, so one
 *   window produces one injection carrying the whole list.
 */

export interface BatchedHit {
  aggregateType: string;
  aggregateId: string;
  /** Only `entity.created` carries one; never used for matching. */
  key: string | null;
  from: string | null;
  to: string | null;
  eventType: string;
  operator: string;
  workspaceId: string;
  /** The newest event's timestamp (ISO), for the list line. */
  timestamp: string;
  /** How many events were folded into this entry. */
  hitCount: number;
}

export interface CoalescedBatch {
  sessionId: string;
  subscription: EventSubscription;
  /** The project the rule was read from; the recheck resolves its `server` from here. */
  projectCwd: string | null;
  openedAt: number;
  closedAt: number;
  /** One entry per aggregate, in first-seen order. */
  hits: BatchedHit[];
  /** Total events folded in (the sum of `hitCount`). */
  count: number;
  /**
   * True when at least one hit is *backfill*: the server replayed it on
   * reconnect (`lib/events/catch-up.ts`). The injection says so, because "this
   * happened 4 minutes ago while you were offline" is not the same instruction
   * as "this just happened".
   */
  catchUp?: boolean;
  /** Publish time of the oldest backfilled event in this batch (epoch ms). */
  catchUpFrom?: number | null;
  /** Publish time of the newest one. */
  catchUpTo?: number | null;
}

interface PendingBatch extends CoalescedBatch {
  timer: unknown;
  byAggregate: Map<string, BatchedHit>;
}

export interface CoalescerDeps {
  now: () => number;
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const DEFAULT_DEPS: CoalescerDeps = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => {
    const timer = setTimeout(handler, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function toHit(descriptor: EventDescriptor): BatchedHit {
  return {
    aggregateType: descriptor.aggregateType,
    aggregateId: descriptor.aggregateId,
    key: descriptor.key,
    from: descriptor.from,
    to: descriptor.to,
    eventType: descriptor.eventType,
    operator: descriptor.operator,
    workspaceId: descriptor.workspaceId,
    timestamp: descriptor.timestamp,
    hitCount: 1,
  };
}

export class Coalescer {
  private readonly pending = new Map<string, PendingBatch>();
  private readonly deps: CoalescerDeps;

  constructor(
    private readonly onFlush: (batch: CoalescedBatch) => void,
    deps: Partial<CoalescerDeps> = {},
  ) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** Number of open windows, for the status panel and tests. */
  get openWindows(): number {
    return this.pending.size;
  }

  add(
    sessionId: string,
    subscription: EventSubscription,
    descriptor: EventDescriptor,
    projectCwd: string | null = null,
    options: { catchUp?: boolean; publishedAt?: number | null } = {},
  ): void {
    const key = subscription.id;
    const now = this.deps.now();
    let batch = this.pending.get(key);

    if (!batch) {
      batch = {
        sessionId,
        subscription,
        projectCwd,
        openedAt: now,
        closedAt: now,
        hits: [],
        count: 0,
        catchUp: false,
        catchUpFrom: null,
        catchUpTo: null,
        timer: null,
        byAggregate: new Map(),
      };
      this.pending.set(key, batch);
      const windowMs = Math.max(0, subscription.coalesceSec * 1000);
      batch.timer = this.deps.setTimeout(() => this.flush(key), windowMs);
    }

    if (options.catchUp) {
      const publishedAt = options.publishedAt ?? null;
      batch.catchUp = true;
      if (publishedAt !== null) {
        batch.catchUpFrom = batch.catchUpFrom === null || batch.catchUpFrom === undefined
          ? publishedAt
          : Math.min(batch.catchUpFrom, publishedAt);
        batch.catchUpTo = batch.catchUpTo === null || batch.catchUpTo === undefined
          ? publishedAt
          : Math.max(batch.catchUpTo, publishedAt);
      }
    }

    const existing = batch.byAggregate.get(descriptor.aggregateId);
    if (existing) {
      existing.hitCount += 1;
      // The newer event decides what the entity looks like now: an earlier
      // `from` would describe a state it has already left.
      existing.from = descriptor.from;
      existing.to = descriptor.to;
      existing.eventType = descriptor.eventType;
      existing.operator = descriptor.operator;
      existing.timestamp = descriptor.timestamp;
      if (descriptor.key) existing.key = descriptor.key;
    } else {
      const hit = toHit(descriptor);
      batch.byAggregate.set(descriptor.aggregateId, hit);
      batch.hits.push(hit);
    }
    batch.count += 1;
    batch.closedAt = now;
  }

  /** Ends one window (timer, shutdown, or a test). */
  flush(key: string): void {
    const batch = this.pending.get(key);
    if (!batch) return;
    this.pending.delete(key);
    this.deps.clearTimeout(batch.timer);
    this.onFlush({
      sessionId: batch.sessionId,
      subscription: batch.subscription,
      projectCwd: batch.projectCwd,
      openedAt: batch.openedAt,
      closedAt: this.deps.now(),
      hits: batch.hits,
      count: batch.count,
      catchUp: batch.catchUp,
      catchUpFrom: batch.catchUpFrom,
      catchUpTo: batch.catchUpTo,
    });
  }

  flushAll(): void {
    for (const key of [...this.pending.keys()]) this.flush(key);
  }

  dispose(): void {
    for (const batch of this.pending.values()) this.deps.clearTimeout(batch.timer);
    this.pending.clear();
  }
}

/**
 * Two batches of one rule into one — the busy path (SSR-000097 AC-6).
 *
 * A session that is already running a turn must not be interrupted, so the hits
 * of every window that closes meanwhile are parked. When the turn ends they are
 * delivered **once**, carrying all of them; the rule's own `coalesceSec` is
 * still respected, this just merges the windows that closed while it was busy.
 *
 * Same aggregate merging as `add()`: the newer event wins for `from`/`to`, and
 * `hitCount` keeps saying how often the entity moved.
 */
export function mergeBatches(earlier: CoalescedBatch, later: CoalescedBatch): CoalescedBatch {
  const hits: BatchedHit[] = earlier.hits.map((hit) => ({ ...hit }));
  const byAggregate = new Map(hits.map((hit) => [hit.aggregateId, hit]));
  for (const hit of later.hits) {
    const existing = byAggregate.get(hit.aggregateId);
    if (existing) {
      existing.hitCount += hit.hitCount;
      existing.from = hit.from;
      existing.to = hit.to;
      existing.eventType = hit.eventType;
      existing.operator = hit.operator;
      existing.timestamp = hit.timestamp;
      if (hit.key) existing.key = hit.key;
      continue;
    }
    const copy = { ...hit };
    byAggregate.set(copy.aggregateId, copy);
    hits.push(copy);
  }
  return {
    sessionId: later.sessionId,
    // The newest rule configuration wins: the file is the intent, and it may
    // have been edited while the session was busy.
    subscription: later.subscription,
    projectCwd: later.projectCwd ?? earlier.projectCwd,
    openedAt: Math.min(earlier.openedAt, later.openedAt),
    closedAt: Math.max(earlier.closedAt, later.closedAt),
    hits,
    count: earlier.count + later.count,
    catchUp: Boolean(earlier.catchUp || later.catchUp),
    catchUpFrom: minOf(earlier.catchUpFrom, later.catchUpFrom),
    catchUpTo: maxOf(earlier.catchUpTo, later.catchUpTo),
  };
}

function minOf(a: number | null | undefined, b: number | null | undefined): number | null {
  const values = [a, b].filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.min(...values) : null;
}

function maxOf(a: number | null | undefined, b: number | null | undefined): number | null {
  const values = [a, b].filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.max(...values) : null;
}
