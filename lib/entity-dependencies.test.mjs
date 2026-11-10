import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
const {
  readStateGuards,
  staleDependencies,
  staleDependencyLine,
} = await jiti.import("./entity-dependencies.ts");

// The shapes `get_metadata` really answers for TASK (manhu-demo, f9b300d): the
// guarded routes are DRAFT→DEFINED (only FINISHED) and BLOCKED→DEFINED (FINISHED
// or INVALID), each with the base's own human sentence.
const lifecycle = {
  initialState: "DRAFT",
  validStates: ["DRAFT", "DEFINED", "IN_PROGRESS", "BLOCKED", "FINISHED", "INVALID"],
  routes: [
    {
      from: "DRAFT",
      to: "DEFINED",
      name: "定稿",
      guard: "all(depends_on, it.state in ['FINISHED', 'INVALID'])",
      guard_description: "依赖的任务必须都已完成或已作废",
    },
    { from: "DEFINED", to: "IN_PROGRESS", name: "开始" },
    {
      from: "BLOCKED",
      to: "DEFINED",
      name: "人工已处理",
      guard: "all(depends_on, it.state in ['FINISHED', 'INVALID'])",
      guard_description: "依赖的任务必须都已完成或已作废（人不该替依赖签字）",
    },
  ],
};

const row = (state, extra = {}) => ({
  key: "TASK-000040",
  type: "TASK",
  name: "被依赖的任务",
  state,
  linkType: "depends_on",
  ...extra,
});

test("the guard's expected states are read from the expression, not guessed", () => {
  const guards = readStateGuards(lifecycle);
  assert.equal(guards.length, 2);
  assert.deepEqual(guards.map((guard) => guard.from), ["DRAFT", "BLOCKED"]);
  for (const guard of guards) {
    assert.equal(guard.relation, "depends_on");
    assert.deepEqual(guard.expectedStates, ["FINISHED", "INVALID"]);
  }
  assert.equal(guards[0].description, "依赖的任务必须都已完成或已作废");
});

test("a single-state comparison and a double-quoted set are read too", () => {
  const guards = readStateGuards({
    routes: [
      { from: "DRAFT", to: "DEFINED", guard: "all(fixes, it.state = 'RESOLVED')" },
      { from: "DEFINED", to: "FINISHED", guard: 'all(depends_on, it.state in ["FINISHED"])' },
    ],
  });
  assert.deepEqual(guards.map((guard) => [guard.relation, guard.expectedStates]), [
    ["fixes", ["RESOLVED"]],
    ["depends_on", ["FINISHED"]],
  ]);
});

test("an expression it does not claim stays silent instead of inventing a requirement", () => {
  const guards = readStateGuards({
    routes: [
      { from: "DRAFT", to: "DEFINED", guard: "count(depends_on, it.state != 'INVALID') >= 1" },
      { from: "DRAFT", to: "INVALID", guard: "all(depends_on, it.state in ['FINISHED'])" },
    ],
  });
  assert.deepEqual(guards.map((guard) => guard.relation), ["depends_on"]);
});

test("satisfied: a target inside the accepted set shows nothing", () => {
  assert.deepEqual(
    staleDependencies({ state: "DRAFT", lifecycle, upstream: [row("FINISHED")] }),
    [],
  );
  assert.deepEqual(
    staleDependencies({ state: "DRAFT", lifecycle, upstream: [row("INVALID")] }),
    [],
  );
});

test("unsatisfied: the target and its state are named, with the states it needs", () => {
  const stale = staleDependencies({ state: "DRAFT", lifecycle, upstream: [row("DRAFT")] });
  assert.equal(stale.length, 1);
  assert.equal(
    staleDependencyLine(stale[0]),
    "依赖已失效：TASK-000040 当前 DRAFT（需要 FINISHED / INVALID）",
  );
});

test("the guard of the current state decides, so the wording matches the route it blocks", () => {
  // Two guarded routes, different acceptance: from DRAFT only FINISHED passes,
  // from BLOCKED an INVALID dependency is fine too.
  const differing = {
    routes: [
      { from: "DRAFT", to: "DEFINED", guard: "all(depends_on, it.state in ['FINISHED'])", guard_description: "依赖的任务必须已完成" },
      { from: "BLOCKED", to: "DEFINED", guard: "all(depends_on, it.state in ['FINISHED', 'INVALID'])" },
    ],
  };
  const draft = staleDependencies({ state: "DRAFT", lifecycle: differing, upstream: [row("INVALID")] });
  assert.equal(staleDependencyLine(draft[0]), "依赖已失效：TASK-000040 当前 INVALID（需要 FINISHED）");
  assert.deepEqual(
    staleDependencies({ state: "BLOCKED", lifecycle: differing, upstream: [row("INVALID")] }),
    [],
  );
  // A state no guarded route starts from still gets checked: silence there would
  // be exactly the "only when the next transition fails" gap AC-11 rules out.
  assert.equal(
    staleDependencies({ state: "IN_PROGRESS", lifecycle: differing, upstream: [row("INVALID")] }).length,
    1,
  );
});

test("no dependencies: an empty upstream list never produces a notice", () => {
  assert.deepEqual(staleDependencies({ state: "DRAFT", lifecycle, upstream: [] }), []);
  assert.deepEqual(staleDependencies({ state: "DRAFT", lifecycle }), []);
});

test("relations that carry no guard are not judged", () => {
  assert.deepEqual(
    staleDependencies({
      state: "DRAFT",
      lifecycle,
      upstream: [row("DRAFT", { key: "SSR-000001", type: "SSR", linkType: "implements" })],
    }),
    [],
  );
});

test("a type without guards reports nothing, even with unfinished targets", () => {
  assert.deepEqual(
    staleDependencies({ state: "DRAFT", lifecycle: { routes: [] }, upstream: [row("DRAFT")] }),
    [],
  );
});

test("the notice never exposes the guard language to the reader", () => {
  const stale = staleDependencies({ state: "DRAFT", lifecycle, upstream: [row("DRAFT")] });
  const line = staleDependencyLine(stale[0]);
  for (const term of ["guard", "STATE_GUARD_", "it.state", "depends_on"]) {
    assert.equal(line.includes(term), false, `the notice must not contain ${term}`);
  }
  assert.match(line, /^依赖已失效：TASK-000040 当前 DRAFT/);
});

test("recomputing is pure: the same inputs answer the same, and nothing is mutated", () => {
  const upstream = [row("DRAFT")];
  const snapshot = JSON.stringify(upstream);
  const first = staleDependencies({ state: "DRAFT", lifecycle, upstream });
  const second = staleDependencies({ state: "DRAFT", lifecycle, upstream });
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(upstream), snapshot);
  // No `suspect` marker is produced anywhere: the answer is this array, full stop.
  assert.deepEqual(Object.keys(first[0]).sort(), [
    "description",
    "expectedStates",
    "key",
    "name",
    "relation",
    "state",
    "type",
  ]);
});
