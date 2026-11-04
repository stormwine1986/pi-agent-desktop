import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { extractEventColumns } = await jiti.import("./event-fields.ts");

const envelope = {
  eventId: "evt_1",
  eventType: "entity.transitioned",
  aggregateId: "agg-1",
  aggregateType: "MR",
  workspaceId: "ws_manhu",
  payload: { toState: "DEFINED", key: "MR-2026-001" },
};

test("reads the documented envelope", () => {
  const columns = extractEventColumns(envelope, { eventName: "entity.transitioned", sseId: "1-0" });
  assert.equal(columns.eventType, "entity.transitioned");
  assert.equal(columns.entityType, "MR");
  assert.equal(columns.workspaceId, "ws_manhu");
  assert.equal(columns.state, "DEFINED");
  assert.equal(columns.key, "MR-2026-001");
  assert.equal(columns.eventId, "evt_1");
});

test("falls back to the SSE frame for type and id, and to the yaml for the workspace", () => {
  const columns = extractEventColumns({ payload: { toState: "DRAFT" } }, {
    eventName: "entity.created",
    sseId: "1761466000000-0",
    workspaceIdParam: "ws_entity_base",
  });
  assert.equal(columns.eventType, "entity.created");
  assert.equal(columns.eventId, "1761466000000-0");
  assert.equal(columns.workspaceId, "ws_entity_base");
  assert.equal(columns.entityType, null);
  assert.equal(columns.key, null);
});

test("finds the business key in the places productions actually put it", () => {
  assert.equal(extractEventColumns({ key: "K1" }).key, "K1");
  assert.equal(extractEventColumns({ payload: { key: "K2" } }).key, "K2");
  assert.equal(extractEventColumns({ payload: { fields: { key: "K3" } } }).key, "K3");
  assert.equal(extractEventColumns({ aggregateKey: "K4" }).key, "K4");
  assert.equal(extractEventColumns({ data: { key: "K5" } }).key, "K5");
  assert.equal(extractEventColumns({ entityKey: "K6" }).key, "K6");
  // Numbers are shown as text rather than dropped.
  assert.equal(extractEventColumns({ payload: { key: 42 } }).key, "42");
});

test("never throws on odd payloads", () => {
  for (const value of [null, "text", 7, [], { payload: "not-an-object" }]) {
    const columns = extractEventColumns(value);
    assert.equal(typeof columns.eventType, "string");
    assert.equal(columns.key, null);
  }
});
