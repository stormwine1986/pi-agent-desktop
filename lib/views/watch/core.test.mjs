import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { sliceDql, countClaims, renderPrompt, formatFields, describeGate } = await jiti.import("./core.ts");

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

test("attempts are counted by how often the entity entered the claim state", () => {
  assert.equal(countClaims([], "IN_PROGRESS"), 0);
  assert.equal(countClaims(["DEFINED"], "IN_PROGRESS"), 0);
  assert.equal(countClaims(["DEFINED", "IN_PROGRESS"], "IN_PROGRESS"), 1);
  // A person moved it out of BLOCKED and back into the queue: the next dispatch
  // is the second attempt, and nothing else can produce a number above one.
  assert.equal(countClaims(["DEFINED", "IN_PROGRESS", "BLOCKED", "DEFINED", "IN_PROGRESS"], "IN_PROGRESS"), 2);
});

test("a claim that ended in another state is still counted as an attempt", () => {
  // The first attempt succeeded, so the second is still the second dispatch.
  assert.equal(countClaims(["DEFINED", "IN_PROGRESS", "FINISHED"], "IN_PROGRESS"), 1);
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

test("the two gate reasons read the way the contract states them", () => {
  assert.equal(describeGate({ reason: "session" }), "项目有运行中会话");
  assert.equal(describeGate({ reason: "manual", count: 3 }), "有 3 条待人工");
});
