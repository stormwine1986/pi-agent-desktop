import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { normalizeEnvelope, matchesSubscription } = await jiti.import("./match.ts");

/** A `DomainEvent` envelope as the stream sends it at `level=envelope`. */
function envelope(overrides = {}) {
  return {
    eventId: "e1",
    eventType: "entity.transitioned",
    aggregateId: "ent_1",
    aggregateType: "Widget",
    workspaceId: "ws_a",
    revision: 3,
    previousRevision: 2,
    operator: "alice",
    timestamp: "2026-11-11T02:00:00.000Z",
    payload: { fromState: "OPEN", toState: "DONE", changedFields: ["state"] },
    ...overrides,
  };
}

const NO_MATCH = {
  eventType: null,
  aggregateType: null,
  from: null,
  to: null,
  changedFields: null,
  operator: null,
};

test("a transition carries fromState/toState", () => {
  const descriptor = normalizeEnvelope(envelope());
  assert.equal(descriptor.from, "OPEN");
  assert.equal(descriptor.to, "DONE");
  assert.deepEqual(descriptor.changedFields, ["state"]);
  assert.equal(descriptor.aggregateType, "Widget");
});

test("created has no from and takes payload.state as to", () => {
  const descriptor = normalizeEnvelope(envelope({
    eventType: "entity.created",
    payload: { key: "WIDGET-1", state: "OPEN", fields: {} },
  }));
  assert.equal(descriptor.from, null);
  assert.equal(descriptor.to, "OPEN");
  assert.equal(descriptor.key, "WIDGET-1");
});

test("created without a state stays state-less", () => {
  const descriptor = normalizeEnvelope(envelope({ eventType: "entity.created", payload: {} }));
  assert.equal(descriptor.from, null);
  assert.equal(descriptor.to, null);
});

test("updated has no state pair at all", () => {
  const descriptor = normalizeEnvelope(envelope({
    eventType: "entity.updated",
    payload: { changedFields: ["priority"] },
  }));
  assert.equal(descriptor.from, null);
  assert.equal(descriptor.to, null);
  assert.deepEqual(descriptor.changedFields, ["priority"]);
});

test("a frame without an id or a type is not an event", () => {
  assert.equal(normalizeEnvelope({ eventType: "entity.updated" }), null);
  assert.equal(normalizeEnvelope("nope"), null);
});

test("an empty match accepts every event", () => {
  assert.equal(matchesSubscription(normalizeEnvelope(envelope()), NO_MATCH), true);
});

test("a to-list matches only the named states", () => {
  const descriptor = normalizeEnvelope(envelope());
  assert.equal(matchesSubscription(descriptor, { ...NO_MATCH, to: ["STUCK", "DONE"] }), true);
  assert.equal(matchesSubscription(descriptor, { ...NO_MATCH, to: ["STUCK"] }), false);
  // A state-less event never matches a concrete list.
  const created = normalizeEnvelope(envelope({ eventType: "entity.created", payload: {} }));
  assert.equal(matchesSubscription(created, { ...NO_MATCH, to: ["DONE"] }), false);
  assert.equal(matchesSubscription(created, { ...NO_MATCH, from: ["*"] }), true);
});

test("wildcards and operator/type predicates", () => {
  const descriptor = normalizeEnvelope(envelope());
  assert.equal(matchesSubscription(descriptor, { ...NO_MATCH, to: ["*"], operator: ["alice"] }), true);
  assert.equal(matchesSubscription(descriptor, { ...NO_MATCH, operator: ["bob"] }), false);
  assert.equal(matchesSubscription(descriptor, { ...NO_MATCH, aggregateType: ["Gadget"] }), false);
  assert.equal(matchesSubscription(descriptor, { ...NO_MATCH, eventType: ["entity.created"] }), false);
});

test("changedFields matches on intersection", () => {
  const descriptor = normalizeEnvelope(envelope());
  assert.equal(matchesSubscription(descriptor, { ...NO_MATCH, changedFields: ["priority", "state"] }), true);
  assert.equal(matchesSubscription(descriptor, { ...NO_MATCH, changedFields: ["priority"] }), false);
});

test("the matcher knows no entity type or state name", async () => {
  // The mechanism must not hard-code a vocabulary (SSR-000097【边界】). Any name
  // of the same shape behaves identically — that is AC-3's code-side half.
  const { readFileSync } = await import("node:fs");
  for (const file of ["match.ts", "batch.ts", "inject-text.ts", "connection.ts", "runtime.ts", "delivery.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bTASK\b/, `${file} must not name an entity type`);
    assert.doesNotMatch(source, /\bFINISHED\b/, `${file} must not name a state`);
  }
});
