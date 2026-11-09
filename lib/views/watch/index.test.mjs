import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * The end-to-end wire for the two dispatch gates: `pumpView` is stubbed in
 * `pump.test.mjs`, but the reason the panel reads comes from `index.ts` state.
 * Here the real pump loop runs against injected deps, so a closed gate must end
 * up as `skipped: "..."` on the view status — never as a silently empty queue.
 */

const root = mkdtempSync(join(tmpdir(), "watch-index-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

const VIEWS_YAML = (dql) => `views:
  - title: 待执行任务
    server: entity-base
    workspace: ws_entity_base
    dql: "${dql}"
    columns: [key]
    watch:
      enabled: true
      project: .
      prompt: task.md
      intervalSec: 1
      timeoutMin: 120
      claim:
        from: DEFINED
        to: IN_PROGRESS
        manual: BLOCKED
`;

function projectFixture(name, dql) {
  const project = join(root, name);
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, "task.md"), "处理 {{key}}");
  writeFileSync(join(project, ".pi", "views.yaml"), VIEWS_YAML(dql));
  return project;
}

const project = projectFixture("board", "type = 'TASK' and state = 'DEFINED'");
const busyProject = projectFixture("board-busy", "type = 'TASK' and state = 'DEFINED'");
const manualProject = projectFixture("board-manual", "type = 'TASK' and state = 'DEFINED'");
const requeueProject = projectFixture("board-requeue", "type = 'TASK' and state = 'DEFINED'");
const unsliceable = projectFixture("board-unsliceable", "type = 'TASK' and state in ('DEFINED', 'DRAFT')");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { startWatchPump, watchViewStatus } = await jiti.import("./index.ts");
const { readViewsConfig } = await jiti.import("../config.ts");

const viewOf = (cwd) => readViewsConfig(cwd).views[0]?.view;

const TASK_STATES = ["DRAFT", "DEFINED", "IN_PROGRESS", "BLOCKED", "FINISHED", "INVALID"];
const ROUTES = [
  { from: "DEFINED", to: "IN_PROGRESS" },
  { from: "IN_PROGRESS", to: "BLOCKED" },
];

function makeDeps(options = {}) {
  const started = [];
  return {
    started,
    now: () => Date.now(),
    async list(_target, query) {
      if (options.claimed && query.includes("IN_PROGRESS")) return { ok: true, value: options.claimed };
      if (options.pending && !query.includes("IN_PROGRESS")) return { ok: true, value: options.pending };
      return { ok: true, value: [] };
    },
    async get() {
      return { ok: true, value: options.entityAfter ?? { key: "TASK-000900", state: "FINISHED", revision: 2 } };
    },
    async states() {
      return { ok: true, value: options.states ?? [] };
    },
    async promote() {
      return { ok: true, value: null };
    },
    async metadata() {
      return { ok: true, value: { validStates: TASK_STATES, routes: ROUTES } };
    },
    async projectBusy() {
      return options.busy ?? false;
    },
    async count() {
      return { ok: true, value: options.manualCount ?? 0 };
    },
    async startSession(runCwd, prompt, title) {
      let finish;
      const done = new Promise((resolve) => {
        finish = resolve;
      });
      started.push({ runCwd, prompt, title, finish });
      return { ok: true, value: { sessionId: `s-${started.length}`, done } };
    },
    log() {
      // keep the test quiet; the assertions read the status, not the log
    },
  };
}

/** Runs the real loop until the view status satisfies the predicate, then stops it. */
async function pumpUntil(deps, cwd, predicate) {
  const view = viewOf(cwd);
  assert.ok(view, "the fixture must parse into a view");
  const stop = startWatchPump({ deps, projects: async () => [cwd], intervalMs: 10 });
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const status = watchViewStatus(cwd, view);
      if (status && predicate(status)) return status;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("timed out waiting for a view status");
  } finally {
    stop();
  }
}


after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

test("a running session in the target project shows up as the skip reason", async () => {
  const status = await pumpUntil(makeDeps({ busy: true }), busyProject, (s) => s.skipped !== null);
  assert.equal(status.disabled, null);
  assert.equal(status.skipped, "项目有运行中会话");
});

test("a parked entity shows up as a count, not as an empty queue", async () => {
  const status = await pumpUntil(makeDeps({ manualCount: 2 }), manualProject, (s) => s.skipped !== null);
  assert.equal(status.disabled, null);
  assert.equal(status.skipped, "有 2 条待人工");
});

test("an open gate dispatches and leaves no skip reason", async () => {
  const deps = makeDeps({
    pending: [{ id: "id-1", key: "TASK-000900", type: "TASK", state: "DEFINED", revision: 1, modifiedAt: null, fields: {} }],
  });
  const status = await pumpUntil(deps, project, () => deps.started.length === 1);
  assert.equal(status.disabled, null);
  assert.equal(status.skipped, null);
  deps.started[0].finish();
});

test("moving the parked entity back opens the gate on the next round", async () => {
  const closed = await pumpUntil(
    makeDeps({ manualCount: 1 }),
    requeueProject,
    (status) => status.skipped === "有 1 条待人工",
  );
  assert.equal(closed.skipped, "有 1 条待人工");

  const open = await pumpUntil(makeDeps({ manualCount: 0 }), requeueProject, (status) => status.skipped === null);
  assert.equal(open.skipped, null);
});

test("an unsliceable DQL is disabled at configuration time, with the view name", async () => {
  const status = await pumpUntil(makeDeps(), unsliceable, (s) => s.disabled !== null);
  assert.match(status.disabled, /state/);
  assert.match(status.disabled, /待执行任务/);
  assert.equal(status.skipped, null);
});
