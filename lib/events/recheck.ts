/**
 * `recheck: true` — the entity is read again before it is injected (SSR-000097
 * AC-7: "事件不是事实").
 *
 * The envelope describes a *change*, not the current world: by the time a batch
 * closes, the entity may have moved on again (the classic case is a state changed
 * and changed back within a second). Injecting the change would make the session
 * reason about a state that no longer exists.
 *
 * What is rechecked, and what is not, is deliberate:
 *
 * - **`to`** (and `aggregateType`) are compared with the entity as it is now;
 * - **`from`**, `changedFields` and `operator` describe the *event*, and a re-read
 *   cannot confirm or refute them — they stay as the envelope said. Pretending
 *   otherwise would drop hits that are still valid.
 *
 * The pure half (`applyRecheck`) is what the tests exercise; the reader below is
 * the only part that talks to the server.
 */

import type { BatchedHit, CoalescedBatch } from "./batch";
import type { SubscriptionMatch } from "./config";
import { matchesValue } from "./match";

/** The entity as it is now, for one aggregate id. */
export interface AggregateSnapshot {
  exists: boolean;
  /** Current state (`entity.state`), null when the type has no state or it is unset. */
  state: string | null;
  aggregateType: string | null;
  /** The workspace the entity actually lives in, when the server said so. */
  workspaceId: string | null;
}

export interface RecheckOutcome {
  /** The batch to deliver, or null when every hit turned out stale. */
  batch: CoalescedBatch | null;
  kept: BatchedHit[];
  /** Aggregate ids that no longer satisfy the rule. */
  stale: string[];
}

/**
 * Keeps the hits whose aggregate still matches the rule's state predicate.
 *
 * A rule without a `to` predicate can only lose a hit when the entity is gone (or
 * moved to another workspace): there is nothing about its state to disprove.
 */
export function applyRecheck(
  batch: CoalescedBatch,
  snapshots: ReadonlyMap<string, AggregateSnapshot>,
  match: SubscriptionMatch,
  expectedWorkspace: string,
): RecheckOutcome {
  const kept: BatchedHit[] = [];
  const stale: string[] = [];
  for (const hit of batch.hits) {
    const snapshot = snapshots.get(hit.aggregateId);
    const gone = !snapshot || !snapshot.exists;
    const wrongWorkspace = Boolean(snapshot?.workspaceId && snapshot.workspaceId !== expectedWorkspace);
    const typeMismatch = Boolean(snapshot?.aggregateType && !matchesValue(match.aggregateType, snapshot.aggregateType));
    const stateMismatch = Boolean(snapshot && !matchesValue(match.to, snapshot.state));
    if (gone || wrongWorkspace || typeMismatch || stateMismatch) {
      stale.push(hit.aggregateId);
      continue;
    }
    kept.push(hit);
  }

  if (kept.length === 0) return { batch: null, kept, stale };

  const count = kept.reduce((sum, hit) => sum + hit.hitCount, 0);
  return {
    batch: { ...batch, hits: kept, count },
    kept,
    stale,
  };
}

/** The `get` result → snapshot; anything unexpected reads as "cannot confirm". */
export function snapshotOf(value: unknown, expectedWorkspace: string): AggregateSnapshot {
  if (typeof value !== "object" || value === null) {
    return { exists: false, state: null, aggregateType: null, workspaceId: null };
  }
  const record = value as Record<string, unknown>;
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId : null;
  const id = typeof record.id === "string" ? record.id : "";
  return {
    // A `get` that answered without an id did not answer about an entity.
    exists: id.length > 0,
    state: typeof record.state === "string" ? record.state : null,
    aggregateType: typeof record.type === "string" ? record.type : null,
    workspaceId: workspaceId ?? expectedWorkspace,
  };
}
