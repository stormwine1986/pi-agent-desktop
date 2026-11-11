import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { EventConnection } = await jiti.import("./connection.ts");

/**
 * A controllable SSE stream plus the ticket endpoint in front of it.
 *
 * `pushes` are the frames the "server" sends; `close()` ends the response, which
 * is what the deployed hub does on a supersede (it sends no frame at all).
 */
function harness() {
  const ticketCalls = [];
  const streamCalls = [];
  const streams = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes("/entity/events/ticket")) {
      ticketCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ticket: "tkt_test", expiresIn: 60 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    streamCalls.push({ url: String(url), headers: init.headers });
    let controller;
    const body = new ReadableStream({
      start(value) { controller = value; },
    });
    streams.push({ controller, closed: false });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetchImpl, ticketCalls, streamCalls, streams };
}

function frame(event, data, id) {
  const lines = [];
  if (id) lines.push(`id: ${id}`);
  lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join("\n")}\n\n`;
}

function event(eventId, toState = "DONE") {
  return {
    eventId,
    eventType: "entity.transitioned",
    aggregateId: "ent_1",
    aggregateType: "Widget",
    workspaceId: "ws_a",
    operator: "alice",
    revision: 1,
    timestamp: "2026-11-11T02:00:00.000Z",
    payload: { fromState: "OPEN", toState },
  };
}

function makeConnection(hooks, overrides = {}) {
  const states = [];
  const events = [];
  const gaps = [];
  const timers = [];
  const connection = new EventConnection({
    key: "entity-base|ws_a",
    serverName: "entity-base",
    workspaceId: "ws_a",
    endpoint: { ticketUrl: "http://x/entity/events/ticket", streamUrl: "http://x/entity/events/stream", headers: { authorization: "Bearer test" } },
    types: ["entity.transitioned"],
    entityTypes: ["Widget"],
    cid: "alice@entity-base",
    onEvent: (descriptor) => events.push(descriptor),
    onState: (state) => states.push(state),
    onGap: (info) => gaps.push(info),
    deps: {
      fetch: hooks.fetchImpl,
      setTimeout: (handler) => { timers.push(handler); return timers.length - 1; },
      clearTimeout: () => {},
      now: () => 1_000,
      maxBackoffMs: 60_000,
    },
    ...overrides,
  });
  return { connection, states, events, gaps, timers };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("ticket then stream: ready makes it active, with the union filter and cid", async () => {
  const hooks = harness();
  const { connection, states, events } = makeConnection(hooks);
  connection.start();
  await tick();
  await tick();

  assert.equal(hooks.ticketCalls.length, 1);
  assert.equal(hooks.ticketCalls[0].init.headers.authorization, "Bearer test");
  assert.equal(hooks.ticketCalls[0].init.method, "POST");

  const streamUrl = new URL(hooks.streamCalls[0].url);
  assert.equal(streamUrl.searchParams.get("ticket"), "tkt_test");
  assert.equal(streamUrl.searchParams.get("workspaceId"), "ws_a");
  assert.equal(streamUrl.searchParams.get("level"), "envelope");
  assert.equal(streamUrl.searchParams.get("cid"), "alice@entity-base");
  assert.equal(streamUrl.searchParams.get("types"), "entity.transitioned");
  assert.equal(streamUrl.searchParams.get("entityTypes"), "Widget");

  hooks.streams[0].controller.enqueue(new TextEncoder().encode(frame("ready", { connectionId: "sse_1" })));
  await tick();
  assert.equal(connection.getState().status, "active");
  assert.equal(connection.getState().connectionId, "sse_1");

  hooks.streams[0].controller.enqueue(new TextEncoder().encode(frame("entity.transitioned", event("e1"), "42-0")));
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].to, "DONE");
  assert.equal(connection.getState().lastEventId, "42-0");
  assert.ok(states.length > 0);
  connection.stop();
});

test("a replayed event id is delivered once", async () => {
  const hooks = harness();
  const { connection, events } = makeConnection(hooks);
  connection.start();
  await tick();
  await tick();

  const encoded = new TextEncoder();
  hooks.streams[0].controller.enqueue(encoded.encode(frame("entity.transitioned", event("e1"), "1-0")));
  hooks.streams[0].controller.enqueue(encoded.encode(frame("entity.transitioned", event("e1"), "1-0")));
  await tick();
  assert.equal(events.length, 1);
  connection.stop();
});

test("a gap is reported, never swallowed", async () => {
  const hooks = harness();
  const { connection, gaps } = makeConnection(hooks);
  connection.start();
  await tick();
  await tick();

  hooks.streams[0].controller.enqueue(new TextEncoder().encode(frame("gap", { reason: "truncated", dropped: 7 })));
  await tick();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].reason, "truncated");
  assert.equal(connection.getState().gapAt, 1_000);
  connection.stop();
});

test("401 on the ticket is auth_failed and stops trying", async () => {
  const calls = [];
  const { connection, states } = makeConnection({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response("{}", { status: 401 });
    },
  });
  connection.start();
  await tick();
  await tick();

  assert.equal(connection.getState().status, "auth_failed");
  assert.equal(calls.length, 1, "no retry after a credential refusal");
  assert.match(connection.getState().lastError, /拒绝访问/);
  assert.ok(states.some((state) => state.status === "auth_failed"));
});

test("a dropped stream reconnects with backoff and resumes with Last-Event-ID", async () => {
  const hooks = harness();
  const { connection, timers } = makeConnection(hooks);
  connection.start();
  await tick();
  await tick();
  hooks.streams[0].controller.enqueue(new TextEncoder().encode(frame("entity.transitioned", event("e1"), "7-0")));
  await tick();

  // The server goes away: the response ends.
  hooks.streams[0].controller.close();
  await tick();
  await tick();
  assert.equal(connection.getState().status, "reconnecting");
  assert.equal(connection.getState().attempt, 1);
  assert.equal(connection.getState().nextRetryMs, 1_000);
  assert.equal(timers.length, 1, "waiting before the next attempt");

  timers.shift()();
  await tick();
  await tick();
  assert.equal(hooks.streamCalls.length, 2);
  assert.equal(hooks.streamCalls[1].headers["Last-Event-ID"], "7-0");

  // Backoff doubles, then caps at 60s.
  hooks.streams[1].controller.close();
  await tick();
  await tick();
  assert.equal(connection.getState().nextRetryMs, 2_000);
  connection.stop();
});

test("a newer instance owning the channel stops the older one instead of fighting", async () => {
  const hooks = harness();
  let owner = true;
  const { connection } = makeConnection(hooks, {
    isChannelOwner: () => (owner
      ? { owner: true }
      : { owner: false, holder: { pid: 2, startedAt: "later" }, reason: "另一实例接管了事件连接" }),
  });
  connection.start();
  await tick();
  await tick();
  hooks.streams[0].controller.enqueue(new TextEncoder().encode(frame("ready", { connectionId: "sse_1" })));
  await tick();
  assert.equal(connection.getState().status, "active");

  owner = false;
  hooks.streams[0].controller.close();
  await tick();
  await tick();
  assert.equal(connection.getState().status, "superseded");
  assert.match(connection.getState().lastError, /另一实例接管/);
  assert.equal(hooks.streamCalls.length, 1, "no reconnect after a supersede");
});

test("no URL or ticket leaks into the reported error", async () => {
  const { connection } = makeConnection({
    fetchImpl: async () => {
      throw new Error("request to http://10.8.0.125:3100/entity/events/stream?ticket=tkt_secret failed");
    },
  });
  connection.start();
  await tick();
  await tick();
  const state = connection.getState();
  assert.equal(state.status, "reconnecting");
  assert.doesNotMatch(state.lastError, /tkt_secret|10\.8\.0\.125|http/);
  connection.stop();
});
