import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * `watch.fill` (TASK-000461) is pure logic: which fields a park carries, what
 * the templates render to, and what counts as uncovered. The pump's wiring is
 * pinned in `watch/pump.test.mjs`; this file pins the rules.
 */
const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  FILL_PLACEHOLDERS,
  placeholdersIn,
  unknownPlaceholders,
  missingFillFields,
  renderFill,
  resolveFill,
} = await jiti.import("./fill.ts");

const values = {
  key: "TASK-000001",
  type: "TASK",
  view: "待执行任务",
  reason: "timeout",
  from: "IN_PROGRESS",
  to: "BLOCKED",
};

test("the placeholder list is the contract, and nothing else is accepted", () => {
  assert.deepEqual([...FILL_PLACEHOLDERS], ["key", "type", "view", "reason", "from", "to"]);
  assert.deepEqual(placeholdersIn("{{key}} / {{reason}} / {{key}}"), ["key", "reason"]);
  assert.deepEqual(unknownPlaceholders("{{key}} {{typo}}"), ["typo"]);
  assert.deepEqual(unknownPlaceholders("没有占位符"), []);
});

test("a template renders every placeholder it uses", () => {
  assert.equal(
    renderFill("【自动】{{view}} · {{key}} 由派发泵写入：{{reason}}（{{from}} → {{to}}，{{type}}）", values),
    "【自动】待执行任务 · TASK-000001 由派发泵写入：timeout（IN_PROGRESS → BLOCKED，TASK）",
  );
});

test("both reasons render as the bare token, so a template can word it", () => {
  // The reason is a fact, not a sentence: the same template serves a timeout and
  // a failed attempt, and the view decides how to say it.
  assert.equal(renderFill("{{reason}}", { ...values, reason: "timeout" }), "timeout");
  assert.equal(renderFill("{{reason}}", { ...values, reason: "failed" }), "failed");
});

test("a template without placeholders is written as-is", () => {
  assert.equal(renderFill("派发泵自动转入待人工", values), "派发泵自动转入待人工");
});

test("missing coverage names exactly the uncovered fields", () => {
  assert.deepEqual(missingFillFields({ remarks: "x" }, ["remarks"]), []);
  assert.deepEqual(missingFillFields({ remarks: "x" }, ["remarks", "solution"]), ["solution"]);
  assert.deepEqual(missingFillFields({}, ["remarks"]), ["remarks"]);
  // A route that requires nothing is covered by any fill, including none.
  assert.deepEqual(missingFillFields({}, []), []);
});

test("only the required fields travel, rendered, in route order", () => {
  const fill = {
    remarks: "【自动】{{view}} · {{key}}：{{reason}}",
    // Configured but not required by this route: must not be sent.
    solution: "{{reason}}",
  };
  assert.deepEqual(resolveFill(fill, ["remarks"], values), {
    remarks: "【自动】待执行任务 · TASK-000001：timeout",
  });
});

test("a route requiring nothing yields no fields at all", () => {
  // This is what keeps the promotion byte-identical for every type that makes
  // no field mandatory on the 待人工 move.
  assert.deepEqual(resolveFill({ remarks: "x" }, [], values), {});
});
