import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { sliceDql, countConsecutiveFailures, renderPrompt, formatFields } = await jiti.import("./core.ts");

test("the state predicate is the only thing replaced", () => {
  // SSR-000090 AC-11: the claimed set must keep this view's other conditions,
  // otherwise two views of the same type see each other's claims.
  const sliced = sliceDql(
    "type = 'Defect' and state = 'CONFIRMED' and affects = 'ssys_x'",
    "CONFIRMED",
    "IN_PROGRESS",
  );
  assert.equal(sliced.ok, true);
  assert.equal(sliced.value, "type = 'Defect' and state = 'IN_PROGRESS' and affects = 'ssys_x'");
});

test("double quotes and spacing survive", () => {
  const sliced = sliceDql(`type = 'TASK' and state="DEFINED"`, "DEFINED", "IN_PROGRESS");
  assert.equal(sliced.ok, true);
  assert.equal(sliced.value, `type = 'TASK' and state="IN_PROGRESS"`);
});

test("a DQL without a state predicate is refused, not guessed", () => {
  const sliced = sliceDql("type = 'MR' and upstream is empty", "DRAFT", "IN_PROGRESS");
  assert.equal(sliced.ok, false);
  assert.match(sliced.error, /state/);
});

test("state in (...) cannot be sliced", () => {
  const sliced = sliceDql("type = 'MR' and state in ('DRAFT', 'CREATED')", "DRAFT", "IN_PROGRESS");
  assert.equal(sliced.ok, false);
});

test("two state predicates are ambiguous and therefore refused", () => {
  const sliced = sliceDql("type = 'MR' and state = 'DRAFT' or state = 'CREATED'", "DRAFT", "IN_PROGRESS");
  assert.equal(sliced.ok, false);
  assert.match(sliced.error, /2/);
});

test("a from that does not match the DQL is reported with both values", () => {
  const sliced = sliceDql("type = 'MR' and state = 'DEFINED'", "DRAFT", "IN_PROGRESS");
  assert.equal(sliced.ok, false);
  assert.match(sliced.error, /DEFINED/);
  assert.match(sliced.error, /DRAFT/);
});

test("a failure streak counts adjacent claim → return pairs", () => {
  const claim = { to: "IN_PROGRESS", back: "DEFINED" };
  assert.equal(countConsecutiveFailures([], claim), 0);
  assert.equal(countConsecutiveFailures(["DEFINED"], claim), 0);
  assert.equal(countConsecutiveFailures(["DEFINED", "IN_PROGRESS", "DEFINED"], claim), 1);
  assert.equal(
    countConsecutiveFailures(["DEFINED", "IN_PROGRESS", "DEFINED", "IN_PROGRESS", "DEFINED"], claim),
    2,
  );
});

test("one success resets the streak (SSR-000090 AC-8)", () => {
  const claim = { to: "IN_PROGRESS", back: "DEFINED" };
  assert.equal(
    countConsecutiveFailures(
      ["DEFINED", "IN_PROGRESS", "DEFINED", "IN_PROGRESS", "FINISHED", "DEFINED", "IN_PROGRESS", "DEFINED"],
      claim,
    ),
    1,
  );
});

test("an unrelated transition never counts as a failure", () => {
  const claim = { to: "IN_PROGRESS", back: "DEFINED" };
  assert.equal(countConsecutiveFailures(["DRAFT", "DEFINED", "INVALID"], claim), 0);
});

test("prompt placeholders are filled, unknown ones left visible", () => {
  const text = renderPrompt("处理 {{key}}（{{type}}），目录 {{runCwd}}，{{nope}}", {
    key: "TASK-000001",
    type: "TASK",
    runCwd: "D:/work",
  });
  assert.equal(text, "处理 TASK-000001（TASK），目录 D:/work，{{nope}}");
});

test("fields render one line each and skip empty values", () => {
  const text = formatFields({ name: "修一下", owner: "", priority: "高", nested: { a: 1 } });
  assert.equal(text, 'name: 修一下\npriority: 高\nnested: {"a":1}');
});
