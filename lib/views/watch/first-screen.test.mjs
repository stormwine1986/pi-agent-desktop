import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/**
 * DEFECT-000104 / TASK-000214: the pump's first round must not run inside the
 * window the desktop shell waits on.
 *
 * Measured on the packaged payload (same machine, same build, fixture board with
 * five watched views): with the pump's first round running immediately,
 * `/api/sessions` answered at +2674 ms behind a 2779 ms event-loop block that the
 * pump's first pi-SDK module load caused; with `PI_WEB_DISABLE_WATCH=1` the same
 * start had no stall over 500 ms after the first screen. The fix is not a faster
 * module load — it is not paying it while the user is waiting for the window.
 *
 * These tests pin the contract of that wait:
 * - nothing runs before the marker;
 * - the marker (written by `GET /api/sessions`) releases the round after a quiet gap;
 * - a server nobody opens a page on still dispatches (the fallback), and says so;
 * - a stop before the marker does not run a round afterwards.
 */

const root = mkdtempSync(join(tmpdir(), "watch-first-screen-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const previousWatchRuns = process.env.PI_WEB_MAX_WATCH_RUNS;
delete process.env.PI_WEB_MAX_WATCH_RUNS;

// The gate's timers are `unref`'d on purpose (a pending gate must never keep the
// server process alive), so the suite holds the loop itself: without this the
// runner can exit while a test is awaiting the fallback.
const keepAlive = setInterval(() => {}, 1_000);

after(() => {
  clearInterval(keepAlive);
  rmSync(root, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousWatchRuns !== undefined) process.env.PI_WEB_MAX_WATCH_RUNS = previousWatchRuns;
});

const VIEWS_YAML = `views:
  - title: 待执行任务
    server: entity-base
    workspace: ws_entity_base
    dql: "type = 'TASK' and state = 'DEFINED'"
    columns: [key]
    watch:
      enabled: true
      project: .
      prompt: task.md
      intervalSec: 60
      timeoutMin: 120
      claim:
        from: DEFINED
        to: IN_PROGRESS
        manual: BLOCKED
`;

function projectFixture(name) {
  const project = join(root, name);
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, "task.md"), "处理 {{key}}");
  writeFileSync(join(project, ".pi", "views.yaml"), VIEWS_YAML);
  return project;
}

const project = projectFixture("board");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { startWatchPump } = await jiti.import("./index.ts");
const { markFirstScreenServed, resetFirstScreenGate, whenFirstScreenServed, FIRST_SCREEN_QUIET_MS, FIRST_SCREEN_FALLBACK_MS } =
  await jiti.import("../../first-screen-gate.ts");

/** A deps stub that only counts rounds: this suite is about *when*, not *what*. */
function countingDeps(events) {
  return {
    now: () => Date.now(),
    async metadata() {
      return { ok: true, value: { validStates: ["DEFINED", "IN_PROGRESS", "BLOCKED"], routes: [
        { from: "DEFINED", to: "IN_PROGRESS" },
        { from: "IN_PROGRESS", to: "BLOCKED" },
      ] } };
    },
    async list() {
      return { ok: true, value: [] };
    },
    async get() {
      return { ok: false, error: "unused" };
    },
    async states() {
      return { ok: true, value: [] };
    },
    async promote() {
      return { ok: true, value: null };
    },
    async startSession() {
      throw new Error("nothing to dispatch in this fixture");
    },
    async projectBusy() {
      return false;
    },
    async count() {
      return { ok: true, value: 0 };
    },
    log(event) {
      events.push(event);
    },
  };
}

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

test("no round runs before the first screen has been served", async () => {
  resetFirstScreenGate();
  const events = [];
  let rounds = 0;
  const stop = startWatchPump({
    deps: countingDeps(events),
    // Rounds are counted by the project list being asked for: `tick()` cannot
    // reach a view without it.
    projects: async () => {
      rounds += 1;
      return [];
    },
    intervalMs: 60_000,
  });
  try {
    await wait(400);
    assert.equal(rounds, 0, "the first round must wait for the marker");
    assert.deepEqual(
      events.filter((event) => event.type === "start"),
      [],
      "and it must not pretend to have started",
    );
  } finally {
    stop();
  }
});

test("the marker releases the first round, after the quiet gap", async () => {
  resetFirstScreenGate();
  const events = [];
  let rounds = 0;
  const stoppedAt = { value: 0 };
  const stop = startWatchPump({
    deps: countingDeps(events),
    projects: async () => {
      rounds += 1;
      stoppedAt.value = Date.now();
      return [];
    },
    intervalMs: 60_000,
  });
  try {
    await wait(150);
    const markedAt = Date.now();
    markFirstScreenServed();
    await wait(FIRST_SCREEN_QUIET_MS - 200);
    assert.equal(rounds, 0, "the round must not start inside the quiet gap");
    for (let attempt = 0; attempt < 100 && rounds === 0; attempt += 1) await wait(20);
    assert.equal(rounds, 1, "the marker must release exactly one round");
    assert.ok(
      stoppedAt.value - markedAt >= FIRST_SCREEN_QUIET_MS - 50,
      `the round must wait for the quiet gap (waited ${stoppedAt.value - markedAt} ms)`,
    );
    const start = events.find((event) => event.type === "start");
    assert.equal(start?.after, "first-screen");
    assert.equal(start?.via, "sessions");
    assert.ok(start.waitedMs >= FIRST_SCREEN_QUIET_MS);
  } finally {
    stop();
  }
});

test("a server nobody opens a page on still dispatches, and says why", async () => {
  resetFirstScreenGate();
  const events = [];
  let rounds = 0;
  const stop = startWatchPump({
    deps: countingDeps(events),
    projects: async () => {
      rounds += 1;
      return [];
    },
    intervalMs: 60_000,
    firstScreenTimeoutMs: 120,
  });
  try {
    for (let attempt = 0; attempt < 100 && rounds === 0; attempt += 1) await wait(20);
    assert.equal(rounds, 1, "the fallback must open the gate when no page ever asks");
    const start = events.find((event) => event.type === "start");
    assert.equal(start?.after, "fallback");
    assert.equal(start?.via, undefined);
  } finally {
    stop();
  }
});

test("a pump stopped before the marker never runs a round", async () => {
  resetFirstScreenGate();
  const events = [];
  let rounds = 0;
  const stop = startWatchPump({
    deps: countingDeps(events),
    projects: async () => {
      rounds += 1;
      return [];
    },
    intervalMs: 60_000,
  });
  stop();
  markFirstScreenServed();
  await wait(FIRST_SCREEN_QUIET_MS + 200);
  assert.equal(rounds, 0);
});

test("the gate is idempotent and reports one served time", async () => {
  resetFirstScreenGate();
  assert.equal((await whenFirstScreenServed(30)).reason, "timeout");
  markFirstScreenServed("sessions");
  const first = (await whenFirstScreenServed(30)).source;
  markFirstScreenServed("again");
  const second = (await whenFirstScreenServed(30)).source;
  assert.equal(first, "sessions");
  assert.equal(second, "sessions", "only the first marker counts");
  assert.ok(FIRST_SCREEN_FALLBACK_MS > FIRST_SCREEN_QUIET_MS);
});

test("GET /api/sessions is what writes the marker", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../app/api/sessions/route.ts"),
    "utf8",
  );
  assert.match(source, /markFirstScreenServed\(\)/);
});
