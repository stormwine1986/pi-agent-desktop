import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { compileFilter } = await jiti.import("./filter.ts");

function test_(expression, value) {
  const compiled = compileFilter(expression);
  assert.equal(compiled.ok, true, `expected "${expression}" to compile`);
  return compiled.filter.test(value);
}

const event = {
  eventType: "entity.transitioned",
  aggregateType: "MR",
  workspaceId: "ws_entity_base",
  revision: 7,
  payload: { toState: "DEFINED", changedFields: ["state"], fields: { state: "DEFINED" } },
};

test("compares nested paths, strings and numbers", () => {
  assert.equal(test_('aggregateType == "MR"', event), true);
  assert.equal(test_('aggregateType == "OR"', event), false);
  assert.equal(test_("payload.toState == 'DEFINED'", event), true);
  assert.equal(test_("payload.fields.state == 'DEFINED'", event), true);
  assert.equal(test_("revision > 6", event), true);
  assert.equal(test_("revision >= 8", event), false);
  // A numeric string compares as a number, so yaml quoting does not matter.
  assert.equal(test_('revision == "7"', event), true);
});

test("supports in, &&, ||, ! and parentheses", () => {
  assert.equal(test_('aggregateType in ["MR", "OR"]', event), true);
  assert.equal(test_('aggregateType in ["PCA"]', event), false);
  assert.equal(test_('eventType == "entity.transitioned" && payload.toState == "DEFINED"', event), true);
  assert.equal(test_('aggregateType == "OR" || revision == 7', event), true);
  assert.equal(test_("!(aggregateType == 'OR')", event), true);
  assert.equal(test_("(aggregateType == 'OR' || aggregateType == 'MR') && revision == 7", event), true);
});

test("a missing path is falsy, not a crash", () => {
  assert.equal(test_("nope.deeper.value == 'x'", event), false);
  assert.equal(test_("nope", event), false);
  assert.equal(test_("payload.changedFields", event), true);
});

test("an empty filter accepts everything", () => {
  assert.equal(test_("", null), true);
  assert.equal(test_("   ", undefined), true);
});

test("bad expressions are reported, never silently accepted", () => {
  for (const expression of ["a ==", "a & b", "(a == 1", "a == 1 and b == 2", "\"unterminated"]) {
    const compiled = compileFilter(expression);
    assert.equal(compiled.ok, false, `expected "${expression}" to fail`);
    assert.equal(typeof compiled.error, "string");
    assert.ok(compiled.error.length > 0);
  }
});

test("the evaluator is not JavaScript: no calls, no assignment, no side effects", () => {
  for (const expression of [
    "process.exit(1)",
    "require('fs')",
    "(() => 1)()",
    "a = 1",
    "globalThis",
  ]) {
    const compiled = compileFilter(expression);
    // Either it fails to parse, or it evaluates to a path lookup that is falsy.
    if (compiled.ok) assert.equal(compiled.filter.test(event), false, expression);
  }
});
