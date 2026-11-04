import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseSseEvents } = await jiti.import("./sse-events.ts");

test("parses one event per blank line and keeps the tail buffered", () => {
  const b = parseSseEvents("event: ping\nid: 7\ndata: {\"a\":1}\n\ndata: hel");
  assert.deepEqual(b.events, [{ id: "7", event: "ping", data: "{\"a\":1}" }]);
  // A chunk boundary can split the next event; it must not be dispatched early.
  assert.equal(b.rest, "data: hel");
});

test("joins multiple data lines and strips one leading space", () => {
  const { events } = parseSseEvents("data: one\ndata: two\n\n");
  assert.deepEqual(events, [{ id: null, event: null, data: "one\ntwo" }]);
});

test("ignores comments (heartbeats) and events with no data field", () => {
  const { events } = parseSseEvents(": keep-alive\n\nevent: only-type\n\nretry: 5000\n\n");
  assert.deepEqual(events, []);
});

test("accepts CRLF line endings", () => {
  const { events } = parseSseEvents("data: ok\r\n\r\n");
  assert.deepEqual(events, [{ id: null, event: null, data: "ok" }]);
});
