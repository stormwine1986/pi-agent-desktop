import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { watchRunLimit, describeWatchRunLimit, maxConcurrentWatchRuns, WATCH_RUNS_ENV } = await jiti.import("./limit.ts");

/**
 * The global cap is a machine gate, not a `views.yaml` field (TASK-000054 追加二):
 * one process-level number, bounded, with the default unchanged at 2 and the
 * effective value printed at startup.
 */

test("unset: the cap is 2, exactly as before the switch existed", () => {
  const limit = watchRunLimit({});
  assert.deepEqual(limit, { limit: 2, source: "default", note: null });
  assert.equal(describeWatchRunLimit(limit), "全局并发上限 = 2（默认）");
});

test("set to a legal value: it takes effect and the log names the source", () => {
  const limit = watchRunLimit({ [WATCH_RUNS_ENV]: "3" });
  assert.deepEqual(limit, { limit: 3, source: "env", note: null });
  assert.equal(describeWatchRunLimit(limit), `全局并发上限 = 3（${WATCH_RUNS_ENV}）`);
  assert.equal(maxConcurrentWatchRuns({ [WATCH_RUNS_ENV]: "1" }), 1);
  assert.equal(maxConcurrentWatchRuns({ [WATCH_RUNS_ENV]: "8" }), 8);
});

test("below the floor is clamped, not obeyed", () => {
  for (const [raw, expected] of [["0", 1], ["-1", 1], ["-99", 1]]) {
    const limit = watchRunLimit({ [WATCH_RUNS_ENV]: raw });
    assert.equal(limit.limit, expected, raw);
    assert.match(limit.note, /已夹取到 1/);
  }
});

test("above the ceiling is clamped to 8, with a note", () => {
  const limit = watchRunLimit({ [WATCH_RUNS_ENV]: "99" });
  assert.equal(limit.limit, 8);
  assert.match(limit.note, /已夹取到 8/);
  assert.match(describeWatchRunLimit(limit), /已夹取到 8/);
});

test("unparseable values fall back to 2 and say so — never throw", () => {
  for (const raw of ["abc", "", "   ", "3.5", "NaN"]) {
    const limit = watchRunLimit({ [WATCH_RUNS_ENV]: raw });
    assert.equal(limit.limit, 2, JSON.stringify(raw));
    assert.equal(limit.source, "env");
    assert.ok(limit.note, `a fallback must be explained for ${JSON.stringify(raw)}`);
    assert.match(describeWatchRunLimit(limit), /全局并发上限 = 2/);
  }
});
