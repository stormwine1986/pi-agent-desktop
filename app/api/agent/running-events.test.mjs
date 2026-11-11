import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSource = readFileSync(new URL("./running/events/route.ts", import.meta.url), "utf8");
const rpcManagerSource = readFileSync(new URL("../../../lib/rpc-manager.ts", import.meta.url), "utf8");

test("running SSE frames carry the session-list version for cross-window refresh", () => {
  assert.match(routeSource, /import \{ getSessionListVersion \} from "@\/lib\/session-list"/);
  const frames = routeSource.match(/encode\(\{ type: "running"[\s\S]*?\}\)/g) ?? [];
  assert.ok(frames.length >= 2, "expected initial + subscriber frames");
  for (const frame of frames) {
    assert.match(frame, /sessionListVersion: getSessionListVersion\(\)/, frame);
  }
});

test("running-state broadcasts fire on both agent_start and agent_end", () => {
  const start = rpcManagerSource.indexOf('if (event.type === "agent_start")');
  const end = rpcManagerSource.indexOf('if (event.type === "agent_end")');
  assert.ok(start !== -1 && end !== -1);
  const startBlock = rpcManagerSource.slice(start, end);
  assert.match(startBlock, /notifyRunningChange\(\)/);
  assert.match(rpcManagerSource.slice(end, end + 400), /notifyRunningChange\(\)/);
});

test("session_info_changed invalidates the list cache and broadcasts a version frame", () => {
  const idx = rpcManagerSource.indexOf('if (event.type === "session_info_changed")');
  assert.ok(idx !== -1);
  const block = rpcManagerSource.slice(idx, idx + 400);
  assert.match(block, /invalidateSessionListCache\(\)/);
  assert.match(block, /notifyRunningChange\(\)/);
});

test("isRunning consults the SDK's isIdle so retry backoff is not mistaken for idle", () => {
  const idx = rpcManagerSource.indexOf("isRunning(): boolean");
  const block = rpcManagerSource.slice(idx, rpcManagerSource.indexOf("evictIfDiskAhead"));
  assert.match(block, /this\.inner\.isIdle/);
  assert.match(block, /sdkIdle === false/);
});

test("idle-timer resets cover retry backoff events", () => {
  const set = rpcManagerSource.slice(
    rpcManagerSource.indexOf("const IDLE_RESET_EVENT_TYPES"),
    rpcManagerSource.indexOf("]);", rpcManagerSource.indexOf("const IDLE_RESET_EVENT_TYPES")),
  );
  for (const type of ["auto_retry_start", "summarization_retry_scheduled", "summarization_retry_attempt_start"]) {
    assert.match(set, new RegExp(`"${type}"`));
  }
  assert.doesNotMatch(set, /"auto_compaction_end"/);
});
