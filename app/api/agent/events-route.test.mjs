import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const agentEventStreamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");

test("agent SSE opens the transport without starting an agent (TASK-000113)", () => {
  // Opening a stream used to call startRpcSession, which built an AgentSession
  // — and loaded the pi SDK, ~1.4 s of blocked loop — before the desktop window
  // was shown. A restored chat is not running: the stream waits for a wrapper.
  assert.match(agentEventsSource, /createAgentEventStream\(req, id, sessionPromise\)/);
  assert.match(agentEventsSource, /sessionPromise = waitForSession\(id, req\.signal\)/);
  assert.doesNotMatch(agentEventsSource, /startRpcSession\(/, "a stream must not start a runtime");
  assert.doesNotMatch(agentEventsSource, /@earendil-works\//, "the first screen must not load the SDK here");
  assert.match(agentEventsSource, /if \(req\.signal\.aborted\) return new Response\(null, \{ status: 204 \}\)/);
  assert.match(agentEventsSource, /"Cache-Control": "no-cache, no-transform"/);
  assert.match(agentEventsSource, /"X-Accel-Buffering": "no"/);
});

test("agent SSE reuses one TextEncoder per stream", () => {
  assert.equal((agentEventStreamSource.match(/new TextEncoder\(\)/g) ?? []).length, 1);
  assert.match(agentEventStreamSource, /controller\.enqueue\(encoder\.encode\(/);
});

test("a stream that opens before an agent exists still completes the transport handshake", () => {
  // The client's readiness timeout waits for `connected`. Without a frame of
  // its own, an idle restored session would be torn down and retried.
  assert.match(agentEventStreamSource, /encode\(\{ type: "connected", sessionId, isStreaming: false \}\)/);
});
