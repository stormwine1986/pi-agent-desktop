import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  sliceDql,
  countClaims,
  renderPrompt,
  formatFields,
  describeGate,
  classifyPromotionFailure,
} = await jiti.import("./core.ts");

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

test("the three gate reasons read the way the contract states them", () => {
  assert.equal(describeGate({ reason: "session" }), "项目有运行中会话");
  assert.equal(describeGate({ reason: "manual", count: 3 }), "有 3 条待人工");
  // The third reason is the machine's cap, and it must not be confusable with
  // the two project-level gates (TASK-000054 追加一).
  assert.equal(describeGate({ reason: "queue", limit: 2 }), "排队中：正在执行的任务已达上限（2 个）");
  assert.equal(describeGate({ reason: "queue", limit: 3 }), "排队中：正在执行的任务已达上限（3 个）");
});

/** The typed body entity-base sends for a route guard rejection. */
function guardBody(code, details = {}) {
  return {
    code,
    statusCode: 409,
    retriable: false,
    skippedByPolicy: true,
    message: `Transition DRAFT → DEFINED on TASK TASK-000029 is blocked by route guard`,
    details: { route: { from: "DRAFT", to: "DEFINED" }, entityType: "TASK", entityKey: "TASK-000029", ...details },
  };
}

function guardText(code) {
  return `Error executing tool 'promotion': [${code}] Transition DRAFT → DEFINED on TASK TASK-000029 is blocked by route guard`;
}

test("a route-guard refusal is a skippable business refusal, said in plain words", () => {
  const verdict = classifyPromotionFailure(
    guardText("STATE_GUARD_UNSATISFIED"),
    guardBody("STATE_GUARD_UNSATISFIED", {
      relation: "depends_on",
      violations: [{ relation: "depends_on", key: "TASK-000029", state: "IN_PROGRESS", expected: ["FINISHED"] }],
    }),
  );
  assert.equal(verdict.kind, "skip");
  assert.equal(verdict.code, "STATE_GUARD_UNSATISFIED");
  assert.equal(verdict.reason, "条目依赖未完成（等待 TASK-000029）");
  // Plain words only: the panel is read by whoever works the queue, not by
  // whoever wrote the guard expression.
  assert.doesNotMatch(verdict.reason, /STATE_GUARD|claim|intervalSec|skippedByPolicy|retriable/);
});

test("the other two guard codes are skips too, each with its own sentence", () => {
  const budget = classifyPromotionFailure(guardText("STATE_GUARD_BUDGET_EXCEEDED"), guardBody("STATE_GUARD_BUDGET_EXCEEDED"));
  const cycle = classifyPromotionFailure(guardText("STATE_GUARD_CYCLE"), guardBody("STATE_GUARD_CYCLE"));
  assert.equal(budget.kind, "skip");
  assert.match(budget.reason, /依赖链超出可检查范围/);
  assert.equal(cycle.kind, "skip");
  assert.match(cycle.reason, /成环/);
  for (const verdict of [budget, cycle]) {
    assert.doesNotMatch(verdict.reason, /STATE_GUARD|claim|intervalSec/);
  }
});

test("the flags, not just the code, decide: a guard code without the business-refusal marks is an error", () => {
  // Same code, but the server says "retry me" — then it is not a business
  // refusal and must not be turned into a quiet wait.
  const bad = classifyPromotionFailure(guardText("STATE_GUARD_UNSATISFIED"), {
    ...guardBody("STATE_GUARD_UNSATISFIED"),
    retriable: true,
    skippedByPolicy: false,
    statusCode: 500,
  });
  assert.equal(bad.kind, "error");
});

test("a concurrent-write conflict keeps its own meaning", () => {
  // `conflict` = "someone else owns this row, take the next one", and it must not
  // be swallowed by the new skip branch even when the server marks it retriable.
  const verdict = classifyPromotionFailure(
    "Error executing tool 'promotion': [CONCURRENT_WRITE_CONFLICT] Concurrent write conflict on entity 'TASK-000001'",
    { code: "CONCURRENT_WRITE_CONFLICT", statusCode: 409, retriable: true },
  );
  assert.equal(verdict.kind, "conflict");
});

test("a real failure stays an error: 502, connection loss, 404, 401", () => {
  const cases = [
    ["entity-base 返回 HTTP 502：bad gateway", undefined],
    ["连不上 entity-base：fetch failed", undefined],
    ["Error executing tool 'get': [ENTITY_NOT_FOUND] no such entity", { code: "ENTITY_NOT_FOUND", statusCode: 404, retriable: false }],
    ["entity-base 拒绝访问（HTTP 401），检查 mcp.json 里的 Authorization", undefined],
  ];
  for (const [error, structured] of cases) {
    assert.equal(classifyPromotionFailure(error, structured).kind, "error", error);
  }
});

test("not every 4xx is a skip: ENTITY_VALIDATION_FAILED stays an error", () => {
  // The whitelist is the point: a bad write cannot be fixed by waiting, so it
  // must keep showing up as a failure (TASK-000054【要做】3).
  const verdict = classifyPromotionFailure(
    "Error executing tool 'promotion': [ENTITY_VALIDATION_FAILED] priority 不是有效值",
    { code: "ENTITY_VALIDATION_FAILED", statusCode: 400, retriable: false },
  );
  assert.equal(verdict.kind, "error");
});
