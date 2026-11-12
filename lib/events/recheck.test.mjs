import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { applyRecheck, snapshotOf } = await jiti.import("./recheck.ts");

const MATCH = { eventType: null, aggregateType: null, from: null, to: ["DONE"], changedFields: null, operator: null };

function batch(hits) {
  return {
    sessionId: "s1",
    subscription: { id: "s1#x" },
    projectCwd: "D:/p",
    openedAt: 1,
    closedAt: 2,
    hits,
    count: hits.reduce((sum, hit) => sum + hit.hitCount, 0),
  };
}

function hit(id, state = "DONE", hitCount = 1) {
  return {
    aggregateType: "Widget",
    aggregateId: id,
    key: null,
    from: "OLD",
    to: state,
    eventType: "entity.transitioned",
    operator: "admin",
    workspaceId: "ws_a",
    timestamp: "2026-11-11T00:00:00.000Z",
    hitCount,
  };
}

function snapshot(state, workspaceId = "ws_a") {
  return { exists: true, state, aggregateType: "Widget", workspaceId };
}

test("a hit that moved back is dropped as stale", () => {
  const outcome = applyRecheck(
    batch([hit("a1"), hit("a2")]),
    new Map([["a1", snapshot("DONE")], ["a2", snapshot("OLD")]]),
    MATCH,
    "ws_a",
  );
  assert.deepEqual(outcome.kept.map((entry) => entry.aggregateId), ["a1"]);
  assert.deepEqual(outcome.stale, ["a2"]);
  assert.equal(outcome.batch.hits.length, 1);
  // The count follows the surviving hits, not the envelope's original number.
  assert.equal(outcome.batch.count, 1);
});

test("nothing survives: the batch is null, which is what records skipped:stale", () => {
  const outcome = applyRecheck(batch([hit("a1"), hit("a2", "DONE", 3)]), new Map([
    ["a1", snapshot("OLD")],
    ["a2", snapshot("OLD")],
  ]), MATCH, "ws_a");
  assert.equal(outcome.batch, null);
  assert.deepEqual(outcome.stale, ["a1", "a2"]);
});

test("a missing entity, another workspace or another type is stale too", () => {
  const outcome = applyRecheck(batch([hit("gone"), hit("moved"), hit("retyped")]), new Map([
    ["gone", { exists: false, state: "DONE", aggregateType: "Widget", workspaceId: "ws_a" }],
    ["moved", snapshot("DONE", "ws_b")],
    ["retyped", { exists: true, state: "DONE", aggregateType: "Gadget", workspaceId: "ws_a" }],
  ]), { ...MATCH, aggregateType: ["Widget"] }, "ws_a");
  assert.equal(outcome.batch, null);
});

test("a rule without a state predicate only loses a hit when the entity is gone", () => {
  const match = { eventType: null, aggregateType: null, from: null, to: null, changedFields: null, operator: null };
  const outcome = applyRecheck(batch([hit("a1"), hit("a2")]), new Map([
    ["a1", snapshot("ANYTHING")],
    ["a2", { exists: false, state: null, aggregateType: null, workspaceId: null }],
  ]), match, "ws_a");
  assert.deepEqual(outcome.kept.map((entry) => entry.aggregateId), ["a1"]);
});

test("snapshotOf reads what a `get` returned and defaults the workspace", () => {
  assert.deepEqual(snapshotOf({ id: "x", type: "Widget", state: "DONE" }, "ws_a"), {
    exists: true,
    state: "DONE",
    aggregateType: "Widget",
    workspaceId: "ws_a",
  });
  // No id means the answer was not about an entity.
  assert.equal(snapshotOf({ type: "Widget" }, "ws_a").exists, false);
  assert.equal(snapshotOf(null, "ws_a").exists, false);
});
