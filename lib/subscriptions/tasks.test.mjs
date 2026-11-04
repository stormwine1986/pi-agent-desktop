import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildTaskPrompt, buildTaskTitle, shouldStartTask } = await jiti.import("./task-prompt.ts");
const { startSubscriptionTask } = await jiti.import("./tasks.ts");

const event = {
  seq: 3,
  receivedAt: "2026-11-04T01:00:00.000Z",
  cwd: "D:/projects/workbench-test",
  source: "Entity",
  eventType: "entity.transitioned",
  entityType: "MR",
  workspaceId: "ws_manhu",
  state: "DEFINED",
  key: "MR-000240",
  action: "new-task",
  eventId: "evt_1",
  data: { eventType: "entity.transitioned", payload: { key: "MR-000240", toState: "DEFINED" } },
};

test("the payload is the instruction; an extra prompt is prepended when configured", () => {
  const bare = buildTaskPrompt(event, "");
  assert.ok(bare.trimStart().startsWith("{"));
  assert.match(bare, /"MR-000240"/);

  const withPrompt = buildTaskPrompt(event, "  核对这条变更并更新追溯链。 ");
  assert.ok(withPrompt.startsWith("核对这条变更并更新追溯链。\n\n{"), withPrompt.slice(0, 40));
  assert.match(withPrompt, /"eventType": "entity\.transitioned"/);
});

test("the session title prefers the business key", () => {
  assert.equal(buildTaskTitle(event), "Entity · MR-000240");
  assert.equal(buildTaskTitle({ ...event, key: null }), "Entity · evt_1");
});

test("task spawning is throttled per source", () => {
  const base = { action: "new-task", taskRunning: false, lastStartedAt: null, now: 1_000_000, cooldownMs: 10_000 };
  assert.equal(shouldStartTask(base), "start");
  // notify events never spawn anything
  assert.equal(shouldStartTask({ ...base, action: "notify" }), "ignore");
  // one at a time
  assert.equal(shouldStartTask({ ...base, taskRunning: true }), "skip-running");
  // and not again inside the cooldown window
  assert.equal(shouldStartTask({ ...base, lastStartedAt: base.now - 5_000 }), "skip-cooldown");
  assert.equal(shouldStartTask({ ...base, lastStartedAt: base.now - 10_000 }), "start");
});

test("starting a task names the session and sends the payload as the first prompt", async () => {
  const sent = [];
  const result = await startSubscriptionTask(
    { cwd: "D:/projects/workbench-test", title: "Entity · MR-000240", prompt: "处理这条事件" },
    async () => ({
      sessionId: "session-1",
      session: {
        async send(command) {
          sent.push(command);
          return { success: true };
        },
      },
    }),
  );

  assert.deepEqual(result, { sessionId: "session-1" });
  assert.deepEqual(sent, [
    { type: "set_session_name", name: "Entity · MR-000240" },
    { type: "prompt", message: "处理这条事件" },
  ]);
});

test("a failing session start is reported, not thrown", async () => {
  const result = await startSubscriptionTask(
    { cwd: "D:/projects/workbench-test", title: "t", prompt: "p" },
    async () => {
      throw new Error("no model configured");
    },
  );
  assert.deepEqual(result, { error: "no model configured" });
});

test("a rejected prompt is reported, not left as a silent dead session", async () => {
  const result = await startSubscriptionTask(
    { cwd: "D:/projects/workbench-test", title: "t", prompt: "p" },
    async () => ({
      sessionId: "session-2",
      session: {
        async send(command) {
          if (command.type === "prompt") throw new Error("prompt_rejected");
          return {};
        },
      },
    }),
  );
  assert.deepEqual(result, { error: "prompt_rejected" });
});
