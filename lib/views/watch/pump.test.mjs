import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * The cap on simultaneous watch sessions is an environment switch (`limit.ts`),
 * and `pumpView` reads the *effective* value every round. These tests assert the
 * default, so the default is what they pin: a machine exporting
 * `PI_WEB_MAX_WATCH_RUNS` (the capacity drill leaves 4 in the user environment)
 * would otherwise decide, from outside the repo, how many slots the machine has.
 */
const previousWatchRuns = process.env.PI_WEB_MAX_WATCH_RUNS;
delete process.env.PI_WEB_MAX_WATCH_RUNS;

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { pumpView, WatchRegistry } = await jiti.import("./pump.ts");
const { describeGate } = await jiti.import("./core.ts");

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
  // No fields to fill by default: the tests that care opt in, which is also what
  // an unconfigured view looks like.
  fill: {},
};

/**
 * The routes a TASK has, with the target one requiring a field — the shape the
 * TASK model takes on once remarks becomes mandatory on IN_PROGRESS → BLOCKED.
 * The pump learns the name from here, never from its own source.
 */
const ROUTES = [
  { from: "DEFINED", to: "IN_PROGRESS", requiredFields: [] },
  { from: "IN_PROGRESS", to: "BLOCKED", requiredFields: ["remarks"] },
];

/** The configured template every fill test uses: every placeholder, one line. */
const FILL = {
  remarks: "【自动】{{view}} · {{key}} 由派发泵写入：{{reason}}（{{from}} → {{to}}，类型 {{type}}）",
};

/** Records what happened, so assertions read like the spec. */
function makeDeps(options) {
  const log = [];
  const promoted = [];
  const sessions = [];
  const listQueries = [];
  const listOptions = [];
  const busyCwds = [];
  const counts = [];
  return {
    log,
    promoted,
    sessions,
    listQueries,
    listOptions,
    busyCwds,
    counts,
    now: () => Date.parse("2026-11-08T04:00:00Z"),
    async list(_target, query, args) {
      listQueries.push(query);
      // The query arguments as `list` receives them: the dispatch order is a
      // configuration decision (SSR-000089 rev33), so it is asserted verbatim.
      listOptions.push({ query, ...args });
      if (query.includes("IN_PROGRESS")) return { ok: true, value: options.claimed ?? [] };
      return { ok: true, value: options.pending ?? [] };
    },
    async get() {
      return { ok: true, value: { ...options.entityAfter } };
    },
    async states() {
      return { ok: true, value: options.states ?? [] };
    },
    async promote(_target, key, to, expectedRevision, fields) {
      // `fields` only when the pump passed it, so "no fields" is asserted as the
      // absent argument it is — not as a key that happens to be undefined.
      const record = (extra = {}) =>
        promoted.push({ key, to, expectedRevision, ...(fields === undefined ? {} : { fields }), ...extra });
      if (options.conflictOn === key) {
        record({ conflict: true });
        return { ok: false, error: "[CONCURRENT_WRITE_CONFLICT] nope", conflict: true };
      }
      if (options.policyOn === key) {
        // Shaped like what `runtime.promote` returns after classification: the
        // pump's job is to record it, not to guess.
        record({ skipped: true });
        return { ok: false, error: "[STATE_GUARD_UNSATISFIED] blocked", skip: options.policySkip };
      }
      if (options.errorOn === key) {
        record({ error: true });
        return { ok: false, error: options.errorMessage ?? "连不上 entity-base：fetch failed" };
      }
      record();
      return { ok: true, value: null };
    },
    async metadata() {
      return {
        ok: true,
        value: {
          validStates: ["DRAFT", "DEFINED", "IN_PROGRESS", "BLOCKED", "FINISHED"],
          routes: options.routes ?? [],
        },
      };
    },
    async projectBusy(runCwd) {
      busyCwds.push(runCwd);
      return options.busy ?? false;
    },
    async count(_target, query) {
      counts.push(query);
      return { ok: true, value: options.manualCount ?? 0 };
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

/** Gives the machine its own environment back; the pin above is this file's only one. */
after(() => {
  if (previousWatchRuns === undefined) delete process.env.PI_WEB_MAX_WATCH_RUNS;
  else process.env.PI_WEB_MAX_WATCH_RUNS = previousWatchRuns;
});

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

test("the dispatched prompt carries the exact key, character for character", async () => {
  // AC-13: the executor must be able to read which entity it owns. Rendering the
  // placeholder is the whole mechanism; nothing is appended on top of it.
  const deps = makeDeps({
    pending: [row("TASK-000016")],
    entityAfter: { ...row("TASK-000016"), state: "FINISHED", revision: 4 },
  });
  await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  const prompt = deps.sessions[0].prompt;
  assert.ok(prompt.split("\n").includes("处理 TASK-000016"), `the key must appear verbatim, got: ${prompt}`);
  assert.equal(prompt.match(/TASK-\d+/g)?.length, 1, "and only where the template asked for it");
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

test("a running session in the target project closes the round before any claim", async () => {
  const deps = makeDeps({
    busy: true,
    pending: [row("TASK-000020")],
    entityAfter: { ...row("TASK-000020"), state: "FINISHED", revision: 4 },
  });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  // The gate asks the project that actually runs the work, and the app-side
  // registry is what answers — a resumed human session counts the same.
  assert.equal(deps.busyCwds[0], "D:/work");
  assert.equal(outcome.status, "skipped");
  assert.deepEqual(outcome.gate, { reason: "session" });
  assert.equal(deps.sessions.length, 0);
  assert.equal(deps.promoted.length, 0);
  assert.ok(deps.log.some((event) => event.type === "skipped" && event.reason === "session"));
});

test("one entity parked in manual stops the whole view, even with older pending rows", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000021"), row("TASK-000022")],
    manualCount: 1,
    entityAfter: { ...row("TASK-000021"), state: "FINISHED", revision: 4 },
  });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(outcome.status, "skipped");
  assert.deepEqual(outcome.gate, { reason: "manual", count: 1 });
  // The slice is the same state substitution the claim uses, so no extra ledger
  // and no other condition of the view is dropped.
  assert.equal(deps.counts.length, 1);
  assert.match(deps.counts[0], /state = 'BLOCKED'/);
  assert.match(deps.counts[0], /type = 'TASK'/);
  assert.equal(deps.promoted.length, 0, "a gated round must not claim anything");
  assert.equal(deps.sessions.length, 0);
  // The pending set is not even read: a row that arrived while the gate was
  // closed is still there next round (AC-10).
  assert.ok(!deps.listQueries.includes(view().dql));
  assert.ok(deps.log.some((event) => event.type === "skipped" && event.reason === "manual" && event.count === 1));
});

test("moving the parked entity back opens the gate and the queue resumes", async () => {
  // The same view and the same registry: only the shared facts on the entity
  // change, which is exactly the human action in AC-15.
  const options = { manualCount: 1, pending: [], entityAfter: row("TASK-000023") };
  const deps = makeDeps(options);
  const live = { ...deps, log: (e) => deps.logEvent(e) };
  const registry = new WatchRegistry();

  const closed = await pumpView({ view: view(), watch, target }, live, registry);
  assert.equal(closed.status, "skipped");

  options.manualCount = 0;
  options.pending = [row("TASK-000023")];
  options.entityAfter = { ...row("TASK-000023"), state: "FINISHED", revision: 4 };
  const open = await pumpView({ view: view(), watch, target }, live, registry);

  assert.equal(open.status, "dispatched");
  assert.equal(deps.sessions.length, 1, "the row that waited out the gate is dispatched");
});

test("a session in another project does not close this view", async () => {
  // The gate is asked per view's target project, never globally: "不同项目互不影响".
  const deps = makeDeps({ busy: false, pending: [row("TASK-000024")], entityAfter: { ...row("TASK-000024"), state: "FINISHED", revision: 4 } });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(outcome.status, "dispatched");
  assert.deepEqual(deps.busyCwds, ["D:/work"]);
});

/** Two other projects already running: the machine's cap is full. */
function fullRegistry() {
  const registry = new WatchRegistry();
  registry.set("D:/one", { key: "TASK-000100", view: "别的视图", startedAt: 1 });
  registry.set("D:/two", { key: "TASK-000101", view: "别的视图", startedAt: 1 });
  return registry;
}

test("the global cap is a third reason, in plain words, and it claims nothing", async () => {
  const deps = makeDeps({ pending: [row("TASK-000030")], entityAfter: row("TASK-000030") });
  const outcome = await pumpView(
    { view: view(), watch, target },
    { ...deps, log: (e) => deps.logEvent(e) },
    fullRegistry(),
  );

  assert.equal(outcome.status, "busy");
  assert.equal(outcome.reason, "global");
  assert.equal(outcome.limit, 2, "the effective cap travels with the outcome");
  assert.equal(describeGate({ reason: "queue", limit: outcome.limit }), "排队中：正在执行的任务已达上限（2 个）");
  assert.equal(deps.promoted.length, 0, "a full machine must not claim anything");
  assert.equal(deps.sessions.length, 0);
  const logged = deps.log.find((event) => event.type === "skipped");
  assert.equal(logged?.reason, "queue");
  assert.equal(logged?.limit, 2);
  assert.doesNotMatch(JSON.stringify(logged), /MAX_CONCURRENT_WATCH_RUNS|registry|inFlight/);
});

test("a raised cap really opens the slot", async () => {
  const previous = process.env.PI_WEB_MAX_WATCH_RUNS;
  process.env.PI_WEB_MAX_WATCH_RUNS = "3";
  try {
    const deps = makeDeps({
      pending: [row("TASK-000031")],
      entityAfter: { ...row("TASK-000031"), state: "FINISHED", revision: 4 },
    });
    const outcome = await pumpView(
      { view: view(), watch, target },
      { ...deps, log: (e) => deps.logEvent(e) },
      fullRegistry(),
    );
    // Two slots were taken; with the cap at 3 the third project gets its turn.
    assert.equal(outcome.status, "dispatched");
    assert.equal(outcome.key, "TASK-000031");
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_MAX_WATCH_RUNS;
    else process.env.PI_WEB_MAX_WATCH_RUNS = previous;
  }
});

test("a route-guard refusal is a skip with a reason, never an error", async () => {
  const skip = { code: "STATE_GUARD_UNSATISFIED", reason: "条目依赖未完成（等待 TASK-000029）" };
  const deps = makeDeps({
    pending: [row("TASK-000029")],
    policyOn: "TASK-000029",
    policySkip: skip,
    entityAfter: row("TASK-000029"),
  });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(outcome.status, "policy");
  assert.equal(outcome.reason, skip.reason);
  assert.equal(deps.sessions.length, 0, "a refused claim starts no session");
  assert.equal(deps.log.filter((event) => event.type === "error").length, 0, "waiting is not a failure");
  const logged = deps.log.find((event) => event.type === "skipped" && event.reason === "policy");
  assert.ok(logged, "the skip is logged as a skip");
  assert.equal(logged.key, "TASK-000029");
  assert.equal(logged.message, skip.reason);
  assert.equal(logged.code, "STATE_GUARD_UNSATISFIED");
  assert.doesNotMatch(logged.message, /STATE_GUARD|claim|intervalSec/);
});

test("a refused candidate does not stop the next one from being claimed", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000032"), row("TASK-000033")],
    policyOn: "TASK-000032",
    policySkip: { code: "STATE_GUARD_UNSATISFIED", reason: "条目依赖未完成（等待 TASK-000099）" },
    entityAfter: { ...row("TASK-000033"), state: "FINISHED", revision: 4 },
  });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(outcome.status, "dispatched");
  assert.equal(outcome.key, "TASK-000033");
  assert.equal(deps.sessions.length, 1);
});

test("a real failure is still an error, and the session is not started", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000034")],
    errorOn: "TASK-000034",
    errorMessage: "entity-base 返回 HTTP 502：bad gateway",
    entityAfter: row("TASK-000034"),
  });
  const outcome = await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /502/);
  assert.equal(deps.sessions.length, 0);
});

// ---------------------------------------------------------------------------
// `watch.fill`: what an automatic park writes (TASK-000461).
//
// The park moves someone's row on the pump's behalf, and the TASK model makes
// `remarks` required on IN_PROGRESS → BLOCKED — but the pump never names a
// field. The name and its content come from the target route's
// `requiredFields` (metadata) and the view's `watch.fill` (configuration), and
// only the intersection travels.
// ---------------------------------------------------------------------------

/** The one park of `key` into the manual state, with the fields it carried. */
function parkedWith(deps, key) {
  const parked = deps.promoted.find((entry) => entry.key === key && entry.to === "BLOCKED");
  assert.ok(parked, `no park for ${key}; promoted: ${JSON.stringify(deps.promoted)}`);
  return parked;
}

test("a configured fill reaches the timeout park, every placeholder rendered", async () => {
  const stale = { ...row("TASK-000050"), modifiedAt: "2026-11-08T00:00:00Z" };
  const deps = makeDeps({ claimed: [stale], pending: [], entityAfter: stale, routes: ROUTES });
  await pumpView(
    { view: view(), watch: { ...watch, fill: FILL }, target },
    { ...deps, log: (e) => deps.logEvent(e) },
    new WatchRegistry(),
  );

  const parked = parkedWith(deps, "TASK-000050");
  assert.deepEqual(parked.fields, {
    remarks: "【自动】待执行任务 · TASK-000050 由派发泵写入：timeout（IN_PROGRESS → BLOCKED，类型 TASK）",
  });
});

test("a configured fill reaches the failed park, with reason=failed", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000051")],
    entityAfter: { ...row("TASK-000051"), state: "IN_PROGRESS", revision: 4 },
    states: ["DEFINED", "IN_PROGRESS"],
    routes: ROUTES,
  });
  await pumpView(
    { view: view(), watch: { ...watch, fill: FILL }, target },
    { ...deps, log: (e) => deps.logEvent(e) },
    new WatchRegistry(),
  );
  deps.sessions[0].finish();
  await waitFor(() => deps.log.some((e) => e.type === "manual"), "the verdict");

  const parked = parkedWith(deps, "TASK-000051");
  assert.deepEqual(parked.fields, {
    remarks: "【自动】待执行任务 · TASK-000051 由派发泵写入：failed（IN_PROGRESS → BLOCKED，类型 TASK）",
  });
});

test("a configured fill reaches the parkAfterTimeout park, with reason=timeout", async () => {
  // 0.001 min = 60 ms: the judge's own timer is what fires here, not the sweep.
  const deps = makeDeps({
    pending: [row("TASK-000052")],
    entityAfter: { ...row("TASK-000052"), state: "IN_PROGRESS", revision: 4 },
    routes: ROUTES,
  });
  await pumpView(
    { view: view(), watch: { ...watch, timeoutMin: 0.001, fill: FILL }, target },
    { ...deps, log: (e) => deps.logEvent(e) },
    new WatchRegistry(),
  );
  await waitFor(() => deps.promoted.some((entry) => entry.to === "BLOCKED"), "the timeout park");

  const parked = parkedWith(deps, "TASK-000052");
  assert.equal(parked.expectedRevision, 4, "the park still guards on the revision it read");
  assert.deepEqual(parked.fields, {
    remarks: "【自动】待执行任务 · TASK-000052 由派发泵写入：timeout（IN_PROGRESS → BLOCKED，类型 TASK）",
  });
});

test("no fill and a route that requires nothing send no fields at all", async () => {
  // Byte for byte what the park did before `watch.fill` existed: the claim, and a
  // park on a route with no required fields.
  const stale = { ...row("TASK-000053"), modifiedAt: "2026-11-08T00:00:00Z" };
  const deps = makeDeps({
    claimed: [stale],
    pending: [row("TASK-000054")],
    entityAfter: { ...row("TASK-000054"), state: "FINISHED", revision: 4 },
    routes: [{ from: "DEFINED", to: "IN_PROGRESS", requiredFields: [] }, { from: "IN_PROGRESS", to: "BLOCKED", requiredFields: [] }],
  });
  await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(parkedWith(deps, "TASK-000053").fields, undefined, "nothing to fill, nothing sent");
  const claim = deps.promoted.find((entry) => entry.key === "TASK-000054");
  assert.equal(claim.to, "IN_PROGRESS");
  assert.equal("fields" in claim, false, "the claim is untouched by this feature");
});

test("fill configured but the route requires nothing: still no fields", async () => {
  const stale = { ...row("TASK-000055"), modifiedAt: "2026-11-08T00:00:00Z" };
  const deps = makeDeps({
    claimed: [stale],
    pending: [],
    entityAfter: stale,
    routes: [{ from: "IN_PROGRESS", to: "BLOCKED", requiredFields: [] }],
  });
  await pumpView(
    { view: view(), watch: { ...watch, fill: FILL }, target },
    { ...deps, log: (e) => deps.logEvent(e) },
    new WatchRegistry(),
  );

  // Only the intersection travels, so an unrelated template never becomes an
  // unexpected write.
  assert.equal("fields" in parkedWith(deps, "TASK-000055"), false);
});

test("a required field the fill does not cover is refused, not sent half-filled", async () => {
  const stale = { ...row("TASK-000056"), modifiedAt: "2026-11-08T00:00:00Z" };
  const deps = makeDeps({
    claimed: [stale],
    pending: [],
    entityAfter: stale,
    routes: [
      { from: "IN_PROGRESS", to: "BLOCKED", requiredFields: ["remarks", "solution"] },
    ],
  });
  await pumpView(
    { view: view(), watch: { ...watch, fill: { remarks: "【自动】{{reason}}" } }, target },
    { ...deps, log: (e) => deps.logEvent(e) },
    new WatchRegistry(),
  );

  assert.equal(deps.promoted.length, 0, "no promotion: a half-filled write would leave the row claimed");
  const error = deps.log.find((event) => event.type === "error");
  assert.ok(error, "the refusal has to be visible");
  assert.match(error.message, /solution/);
  assert.match(error.message, /watch\.fill/);
  assert.match(error.message, /待执行任务/);
  assert.doesNotMatch(error.message, /remarks/, "only the uncovered field is named");
});

test("the claim never carries fields, even with a fill configured", async () => {
  // `watch.fill` is the template for the 待人工 move only: the claim has no
  // executing session behind it, so there is nothing to write and nothing to
  // report. A claim that suddenly grew fields would be an unexpected write.
  const deps = makeDeps({
    pending: [row("TASK-000057")],
    entityAfter: { ...row("TASK-000057"), state: "FINISHED", revision: 4 },
    routes: ROUTES,
  });
  await pumpView(
    { view: view(), watch: { ...watch, fill: FILL }, target },
    { ...deps, log: (e) => deps.logEvent(e) },
    new WatchRegistry(),
  );

  const claim = deps.promoted.find((entry) => entry.key === "TASK-000057");
  assert.equal(claim.to, "IN_PROGRESS");
  assert.equal("fields" in claim, false, "the claim promotion is untouched by watch.fill");
});

// ---------------------------------------------------------------------------
// Dispatch order is the view's own order (SSR-000089 rev33, SSR-000066 rev20).
//
// The pump does not sort: it sends the view's `orderBy`/`order` to `list` and
// claims row 0. What is asserted here is the query arguments and which row was
// claimed — not any local ordering.
// ---------------------------------------------------------------------------

/** The options the pending-set query was made with (the other call is the sweep). */
function pendingQuery(deps, dql) {
  const call = deps.listOptions.find((options) => options.query === dql);
  assert.ok(call, `no list call for the pending set; got ${JSON.stringify(deps.listOptions.map((c) => c.query))}`);
  return call;
}

test("AC-2: a view with no orderBy dispatches with exactly today's query", async () => {
  const deps = makeDeps({
    pending: [row("TASK-000040")],
    entityAfter: { ...row("TASK-000040"), state: "FINISHED", revision: 4 },
  });
  await pumpView({ view: view(), watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  const pendingCall = pendingQuery(deps, view().dql);
  assert.deepEqual(
    { limit: pendingCall.limit, orderBy: pendingCall.orderBy, order: pendingCall.order },
    // The view's own `order` default is `desc` (the table's default); the
    // dispatch fallback has always been oldest-first and stays that.
    { limit: 50, orderBy: "modified_at", order: "asc" },
    "unconfigured views must keep the historical query byte for byte",
  );
  // The timeout sweep keeps its own fixed order, whatever the view sorts by.
  const sweep = deps.listOptions.find((options) => options.query.includes("IN_PROGRESS"));
  assert.deepEqual({ orderBy: sweep.orderBy, order: sweep.order }, { orderBy: "modified_at", order: "asc" });
});

test("AC-3: a multi-key view sends its keys and directions verbatim and claims row 0", async () => {
  const multi = view({ orderBy: ["priority", "modified_at"], order: ["desc", "asc"] });
  const deps = makeDeps({
    // Row 0 is the highest priority by the view's own order.
    pending: [row("TASK-000041"), row("TASK-000042")],
    entityAfter: { ...row("TASK-000041"), state: "FINISHED", revision: 4 },
  });
  const outcome = await pumpView({ view: multi, watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  const pendingCall = pendingQuery(deps, multi.dql);
  assert.deepEqual(pendingCall.orderBy, ["priority", "modified_at"]);
  assert.deepEqual(pendingCall.order, ["desc", "asc"]);
  assert.equal(pendingCall.limit, 50);
  assert.equal(outcome.status, "dispatched");
  assert.equal(outcome.key, "TASK-000041", "the first row the base returned is the one claimed");
  assert.deepEqual(deps.promoted.map((entry) => entry.key), ["TASK-000041"]);
});

test("AC-3: a conflict on row 0 moves to row 1 without changing the order", async () => {
  const multi = view({ orderBy: ["priority", "modified_at"], order: ["desc", "asc"] });
  const deps = makeDeps({
    pending: [row("TASK-000043"), row("TASK-000044")],
    conflictOn: "TASK-000043",
    entityAfter: { ...row("TASK-000044"), state: "FINISHED", revision: 4 },
  });
  const outcome = await pumpView({ view: multi, watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());

  assert.equal(outcome.status, "dispatched");
  assert.equal(outcome.key, "TASK-000044");
  assert.deepEqual(deps.promoted.map((entry) => entry.key), ["TASK-000043", "TASK-000044"]);
  // Same query, tried in order: the fallback is over rows, never over a re-sort.
  assert.deepEqual(pendingQuery(deps, multi.dql).orderBy, ["priority", "modified_at"]);
  assert.ok(deps.log.some((event) => event.type === "conflict" && event.key === "TASK-000043"));
});

test("the scan cap still applies to a multi-key view", async () => {
  const multi = view({ orderBy: ["priority", "modified_at"], order: ["desc", "asc"], pageSize: 100 });
  const deps = makeDeps({ pending: [], entityAfter: row("TASK-000045") });
  await pumpView({ view: multi, watch, target }, { ...deps, log: (e) => deps.logEvent(e) }, new WatchRegistry());
  assert.equal(pendingQuery(deps, multi.dql).limit, 100);
});
