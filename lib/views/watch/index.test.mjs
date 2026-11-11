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

/**
 * The cap on simultaneous watch sessions is an environment switch (`limit.ts`),
 * and the pump reads the *effective* value every round. These tests assert the
 * default, so the default is what they pin: a machine exporting
 * `PI_WEB_MAX_WATCH_RUNS` (the capacity drill leaves 4 in the user environment)
 * would otherwise decide, from outside the repo, how many slots the machine has
 * — with 4, two held slots no longer fill the queue and the round dispatches.
 */
const previousWatchRuns = process.env.PI_WEB_MAX_WATCH_RUNS;
delete process.env.PI_WEB_MAX_WATCH_RUNS;

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
const queueProject = projectFixture("board-queue", "type = 'TASK' and state = 'DEFINED'");
const cappedProject = projectFixture("board-capped", "type = 'TASK' and state = 'DEFINED'");
const policyProject = projectFixture("board-policy", "type = 'TASK' and state = 'DEFINED'");
const errorProject = projectFixture("board-error", "type = 'TASK' and state = 'DEFINED'");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { startWatchPump, watchViewStatus } = await jiti.import("./index.ts");
const { WatchRegistry } = await jiti.import("./pump.ts");
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
      if (options.policy) return { ok: false, error: "[STATE_GUARD_UNSATISFIED] blocked", skip: options.policy };
      if (options.fail) return { ok: false, error: options.fail };
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
    log(event) {
      // keep the test quiet; the assertions read the status, not the log
      options.log?.(event);
    },
  };
}

/** Runs the real loop until the view status satisfies the predicate, then stops it. */
async function pumpUntil(deps, cwd, predicate, options = {}) {
  const view = viewOf(cwd);
  assert.ok(view, "the fixture must parse into a view");
  const stop = startWatchPump({ deps, projects: async () => [cwd], intervalMs: 10, registry: options.registry });
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

const row = (key, revision = 1) => ({
  id: `id-${key}`,
  key,
  type: "TASK",
  state: "DEFINED",
  revision,
  modifiedAt: null,
  fields: {},
});


after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousWatchRuns === undefined) delete process.env.PI_WEB_MAX_WATCH_RUNS;
  else process.env.PI_WEB_MAX_WATCH_RUNS = previousWatchRuns;
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
    pending: [row("TASK-000900")],
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

  // The reason survives a round that finds nothing to dispatch (追加一 ②):
  // "held back" must not become "the queue was never full".
  const quiet = await pumpUntil(makeDeps({ manualCount: 0 }), requeueProject, (status) => status.idle);
  assert.equal(quiet.skipped, "有 1 条待人工");
  assert.equal(quiet.idle, true);

  // A successful dispatch is what clears it — the gate really is open again.
  const deps = makeDeps({ manualCount: 0, pending: [row("TASK-000901")] });
  const open = await pumpUntil(deps, requeueProject, (status) => status.skipped === null);
  assert.equal(open.skipped, null);
  assert.equal(open.idle, false);
  assert.equal(deps.started.length, 1);
  deps.started[0].finish();
});

test("a full machine shows the queue reason, in plain words, told apart from the gates", async () => {
  // Two other projects hold the two slots; the third one has work and cannot run.
  const registry = new WatchRegistry();
  registry.set("D:/other-one", { key: "TASK-000910", view: "别的视图", startedAt: 1 });
  registry.set("D:/other-two", { key: "TASK-000911", view: "别的视图", startedAt: 1 });
  const deps = makeDeps({ pending: [row("TASK-000912")] });
  const status = await pumpUntil(deps, queueProject, (s) => s.skipped !== null, { registry });

  assert.equal(status.skipped, "排队中：正在执行的任务已达上限（2 个）");
  // Human words only: the reader of the panel is not the reader of the code.
  assert.doesNotMatch(status.skipped, /MAX_CONCURRENT|registry|inFlight|WATCH_RUNS/);
  // Three reasons, three sentences.
  assert.notEqual(status.skipped, "项目有运行中会话");
  assert.notEqual(status.skipped, "有 1 条待人工");
  assert.equal(deps.started.length, 0, "the cap must not start a session");

  // Freeing one slot is enough for the next round to claim the row.
  registry.clear("D:/other-one", "TASK-000910");
  const dispatched = await pumpUntil(deps, queueProject, () => deps.started.length === 1, { registry });
  assert.equal(dispatched.skipped, null);
  deps.started[0].finish();
});

test("the queue reason uses the effective cap, not the literal 2", async () => {
  const previous = process.env.PI_WEB_MAX_WATCH_RUNS;
  process.env.PI_WEB_MAX_WATCH_RUNS = "3";
  try {
    const registry = new WatchRegistry();
    registry.set("D:/other-one", { key: "TASK-000920", view: "别的视图", startedAt: 1 });
    registry.set("D:/other-two", { key: "TASK-000921", view: "别的视图", startedAt: 1 });
    const deps = makeDeps({ pending: [row("TASK-000922")] });
    // Cap 3 with two slots taken → the round dispatches; nothing to explain.
    const status = await pumpUntil(deps, cappedProject, () => deps.started.length === 1, { registry });
    assert.equal(status.skipped, null);
    deps.started[0].finish();

    // Now fill all three slots: the sentence must say 3.
    registry.set("D:/other-three", { key: "TASK-000923", view: "别的视图", startedAt: 1 });
    const next = makeDeps({ pending: [row("TASK-000924")] });
    const blocked = await pumpUntil(next, cappedProject, (s) => s.skipped !== null, { registry });
    assert.equal(blocked.skipped, "排队中：正在执行的任务已达上限（3 个）");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_MAX_WATCH_RUNS;
    else process.env.PI_WEB_MAX_WATCH_RUNS = previous;
  }
});

test("a business refusal is a skip with a reason, not an error", async () => {
  const skip = { code: "STATE_GUARD_UNSATISFIED", reason: "条目依赖未完成（等待 TASK-000029）" };
  const deps = makeDeps({ pending: [row("TASK-000930")], policy: skip });
  const status = await pumpUntil(deps, policyProject, (s) => s.skipped !== null);

  assert.equal(status.skipped, skip.reason);
  assert.equal(status.error, null);
  assert.doesNotMatch(status.skipped, /STATE_GUARD|claim|intervalSec/);
});

test("a real failure keeps a visible error state, alongside the skip reason", async () => {
  const deps = makeDeps({ pending: [row("TASK-000940")], fail: "entity-base 返回 HTTP 502：bad gateway" });
  const status = await pumpUntil(deps, errorProject, (s) => s.error !== null);

  assert.match(status.error, /502/);
  // The error is its own field: a previous skip reason is not overwritten by it,
  // and this error is not hidden behind a skip line either.
  assert.equal(status.skipped, null);
});

test("an unsliceable DQL is disabled at configuration time, with the view name", async () => {
  const status = await pumpUntil(makeDeps(), unsliceable, (s) => s.disabled !== null);
  assert.match(status.disabled, /state/);
  assert.match(status.disabled, /待执行任务/);
  assert.equal(status.skipped, null);
});
