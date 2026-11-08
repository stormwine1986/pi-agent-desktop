import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { pumpView, WatchRegistry } = await jiti.import("./pump.ts");

/** A prompt file on disk: `dispatch` reads it before starting the session. */
const promptPath = join(mkdtempSync(join(tmpdir(), "watch-")), "task.md");
writeFileSync(promptPath, "处理 {{key}}\n目录 {{runCwd}}\n");

const claim = { from: "DEFINED", to: "IN_PROGRESS", manual: "BLOCKED" };

function view(overrides = {}) {
  return {
    title: "待执行任务",
    server: "entity-base",
    workspace: "ws_manhu",
    dql: "type = 'TASK' and state = 'DEFINED'",
    columns: ["key"],
    orderBy: null,
    order: "desc",
    pageSize: 50,
    notify: true,
    group: null,
    watch: null,
    ...overrides,
  };
}

const watch = {
  enabled: true,
  project: "D:/work",
  prompt: promptPath,
  intervalSec: 90,
  timeoutMin: 120,
  claim,
};

/** Records what happened, so assertions read like the spec. */
function makeDeps(options) {
  const log = [];
  const promoted = [];
  const sessions = [];
  return {
    log,
    promoted,
    sessions,
    now: () => Date.parse("2026-11-08T04:00:00Z"),
    async list(_target, query) {
      if (query.includes("IN_PROGRESS")) return { ok: true, value: options.claimed ?? [] };
      return { ok: true, value: options.pending ?? [] };
    },
    async get() {
      return { ok: true, value: { ...options.entityAfter } };
    },
    async states() {
      return { ok: true, value: options.states ?? [] };
    },
    async promote(_target, key, to, expectedRevision) {
      if (options.conflictOn === key) {
        promoted.push({ key, to, expectedRevision, conflict: true });
        return { ok: false, error: "[CONCURRENT_WRITE_CONFLICT] nope", conflict: true };
      }
      promoted.push({ key, to, expectedRevision });
      return { ok: true, value: null };
    },
    async metadata() {
      return { ok: true, value: { validStates: ["DRAFT", "DEFINED", "IN_PROGRESS", "BLOCKED", "FINISHED"], routes: [] } };
    },
    async startSession(runCwd, prompt, title) {
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      sessions.push({ runCwd, prompt, title, done, finish: () => resolveDone() });
      return { ok: true, value: { sessionId: `s-${sessions.length}`, done } };
    },
    logEvent(event) {
      log.push(event);
    },
  };
}

const target = { panelCwd: "D:/board", server: "entity-base", workspace: "ws_manhu" };
const row = (key, revision = 3) => ({
  id: `id-${key}`,
  key,
  type: "TASK",
  state: "DEFINED",
  revision,
  modifiedAt: "2026-11-08T03:59:00Z",
  fields: { name: key },
});

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("claimed first, then the session starts with the filled prompt", async () => {
  const deps = makeDeps({ pending: [row("TASK-000001")], entityAfter: { ...row("TASK-000001"), state: "FINISHED", revision: 4 } });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (event) => deps.logEvent(event) }, new WatchRegistry());

  assert.equal(outcome.status, "dispatched");
  assert.equal(deps.promoted[0].to, "IN_PROGRESS", "the claim happens before any session exists");
  assert.equal(deps.promoted[0].expectedRevision, 3);
  assert.equal(deps.sessions.length, 1);
  assert.match(deps.sessions[0].prompt, /TASK-000001/);
  assert.equal(deps.sessions[0].title, "待执行任务 · TASK-000001");
});

test("a retry says which attempt it is, so the sidebar can tell them apart", async () => {
  // Two failed attempts already on record: DEFINED → IN_PROGRESS → DEFINED, twice.
  const deps = makeDeps({
    pending: [row("TASK-000002")],
    states: ["DEFINED", "IN_PROGRESS", "DEFINED", "IN_PROGRESS", "DEFINED", "IN_PROGRESS"],
    entityAfter: { ...row("TASK-000002"), state: "FINISHED", revision: 8 },
  });
  await pumpView({ view: view(), watch, target }, { ...deps, log: (event) => deps.logEvent(event) }, new WatchRegistry());

  // Each attempt is a separate session, so without the number three identical
  // titles sit in the sidebar and none of them says which came last.
  assert.equal(deps.sessions[0].title, "待执行任务 · TASK-000002（第 3 次）");
});

test("a conflicting claim moves to the next candidate instead of starting twice", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000001"), row("TASK-000002")],
    conflictOn: "TASK-000001",
    entityAfter: { ...row("TASK-000002"), state: "FINISHED", revision: 4 },
  });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(outcome.status, "dispatched");
  assert.equal(outcome.key, "TASK-000002");
  assert.equal(deps.sessions.length, 1);
  assert.ok(deps.log.some((event) => event.type === "conflict"));
});

test("when the project is already busy nothing else is claimed", async () => {
  const deps = makeDeps({ pending: [row("TASK-000009")], entityAfter: row("TASK-000009") });
  const registry = new WatchRegistry();
  registry.set("D:/work", { key: "TASK-000008", view: "别的视图", startedAt: 1 });

  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, registry);
  assert.equal(outcome.status, "busy");
  assert.equal(deps.promoted.length, 0, "a busy project must not even claim");
});

test("still claimed after the turn → straight to manual, with no second attempt", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000003")],
    entityAfter: { ...row("TASK-000003"), state: "IN_PROGRESS", revision: 4 },
    states: ["DEFINED", "IN_PROGRESS"],
  });
  const live = { ...deps, log: (e) => deps.logEvent(e) };
  await pumpView({ view: view(), watch, target }, live, new WatchRegistry());
  deps.sessions[0].finish();
  await waitFor(() => deps.log.some((e) => e.type === "manual"), "the verdict");

  // The pump does not retry: an attempt that left the item claimed is a person's
  // problem from here, so nothing is handed back to the pending state.
  assert.equal(deps.promoted.filter((entry) => entry.to === "DEFINED").length, 0);
  const parked = deps.promoted.find((entry) => entry.to === "BLOCKED");
  assert.ok(parked, "a failed attempt parks the item");
  assert.equal(parked.expectedRevision, 4);
  assert.equal(deps.log.find((e) => e.type === "manual").reason, "failed");
});

test("the attempt number counts claims, so a human requeue makes the second", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000010")],
    // One previous claim, parked in manual, then a person moved it back.
    states: ["DEFINED", "IN_PROGRESS", "BLOCKED", "DEFINED", "IN_PROGRESS"],
    entityAfter: { ...row("TASK-000010"), state: "FINISHED", revision: 6 },
  });
  await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(deps.sessions[0].title, "待执行任务 · TASK-000010（第 2 次）");
});

test("a success writes nothing: the executing project already moved the state", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000005")],
    entityAfter: { ...row("TASK-000005"), state: "FINISHED", revision: 4 },
  });
  const live = { ...deps, log: (e) => deps.logEvent(e) };
  await pumpView({ view: view(), watch, target }, live, new WatchRegistry());
  deps.sessions[0].finish();
  await waitFor(() => deps.log.some((e) => e.type === "done"), "the verdict");

  assert.equal(deps.promoted.filter((entry) => entry.to !== "IN_PROGRESS").length, 0);
});

test("a claimed item older than timeoutMin is parked before anything is dispatched", async () => {
  const stale = { ...row("TASK-000006"), modifiedAt: "2026-11-08T00:00:00Z" };
  const deps = makeDeps({ claimed: [stale], pending: [], entityAfter: stale });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(outcome.status, "idle");
  assert.equal(deps.promoted[0].to, "BLOCKED");
  assert.ok(deps.log.some((event) => event.type === "manual" && event.reason === "timeout"));
});
