import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { desiredChannels, channelKey, eventEndpointOf } = await jiti.import("./runtime.ts");

function rule(server, workspace, events, entityTypes) {
  return {
    projectCwd: "D:/p",
    sessionId: "s1",
    title: null,
    subscription: {
      id: `s1#${server}-${events.join("+")}`,
      name: "x",
      server,
      workspace,
      action: "wake",
      filter: { events, entityTypes, operator: null, linkTypes: [], custom: null },
      match: { eventType: null, aggregateType: null, from: null, to: null, changedFields: null, operator: null },
      coalesceSec: 30,
      maxPerHour: 20,
      recheck: false,
      inject: null,
    },
  };
}

test("one channel per (server, workspace), with the union of every rule", () => {
  const wanted = desiredChannels([
    rule("entity-base", "ws_a", ["entity.transitioned"], ["Widget"]),
    rule("entity-base", "ws_a", ["entity.created", "entity.transitioned"], ["Gadget"]),
    rule("entity-base", "ws_b", ["entity.updated"], ["Widget"]),
    rule("other", "ws_a", [], []),
  ]);

  assert.equal(wanted.size, 3);
  const a = wanted.get(channelKey("entity-base", "ws_a"));
  assert.deepEqual(a.types, ["entity.created", "entity.transitioned"]);
  assert.deepEqual(a.entityTypes, ["Gadget", "Widget"]);
  const b = wanted.get(channelKey("entity-base", "ws_b"));
  assert.deepEqual(b.types, ["entity.updated"]);
  // A rule with no filter must widen the channel to "everything", not narrow it.
  const other = wanted.get(channelKey("other", "ws_a"));
  assert.deepEqual(other.types, []);
  assert.deepEqual(other.entityTypes, []);
});

test("a channel with no filter at all sends no type parameters", () => {
  const wanted = desiredChannels([rule("other", "ws_a", [], [])]);
  assert.deepEqual(wanted.get(channelKey("other", "ws_a")).types, []);
});

test("the event endpoints are siblings of the MCP url", () => {
  const endpoint = eventEndpointOf("http://localhost:3000/entity/mcp", { authorization: "Bearer x" });
  assert.equal(endpoint.ticketUrl, "http://localhost:3000/entity/events/ticket");
  assert.equal(endpoint.streamUrl, "http://localhost:3000/entity/events/stream");
  assert.deepEqual(endpoint.headers, { authorization: "Bearer x" });
  // An unrelated endpoint is refused rather than guessed at.
  assert.equal(eventEndpointOf("http://localhost:3000/some/other/path", {}), null);
  assert.equal(eventEndpointOf("not a url", {}), null);
});
