import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { checkOrderBy, declaredSortFields, sortFieldKey } = await jiti.import("./order-by.ts");

const taskMetadata = {
  type: "TASK",
  fields: [
    { name: "name", label: "标题", type: "shorttext" },
    { name: "owner", label: "负责人", type: "shorttext" },
    { name: "priority", label: "优先级", type: "choice", validValues: ["高", "中", "低"] },
    { name: "remarks", label: "备注", type: "text" },
  ],
};

const declared = declaredSortFields(taskMetadata);

test("a field the type declares is accepted", () => {
  assert.deepEqual(checkOrderBy("priority", declared), { ok: true });
  assert.deepEqual(checkOrderBy("owner", declared), { ok: true });
});

test("system fields are sort keys even though no type declares them", () => {
  for (const name of ["key", "state", "revision", "modifiedAt", "createdBy", "name"]) {
    assert.deepEqual(checkOrderBy(name, declared), { ok: true }, name);
  }
});

test("the two spellings the base accepts are one field", () => {
  // `modified_at` and `modifiedAt` both work, so insisting on one would reject
  // working configuration.
  for (const pair of [["modified_at", "modifiedAt"], ["created_by", "createdBy"]]) {
    assert.equal(sortFieldKey(pair[0]), sortFieldKey(pair[1]));
    assert.deepEqual(checkOrderBy(pair[0], declared), { ok: true }, pair[0]);
  }
  // Business fields too: `owner_id` / `ownerId` are the same name.
  assert.deepEqual(checkOrderBy("owner_id", ["ownerId"]), { ok: true });
});

test("an unknown field is refused, and the message says what exists", () => {
  const verdict = checkOrderBy("modifed_at", declared);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /orderBy 指向的字段不存在：「modifed_at」/);
  assert.match(verdict.error, /priority/);
  assert.match(verdict.error, /modifiedAt/);
});

test("a view that does not sort is never refused", () => {
  assert.deepEqual(checkOrderBy(null, declared), { ok: true });
  assert.deepEqual(checkOrderBy(null, null), { ok: true });
});

test("unusable metadata abstains instead of rejecting", () => {
  // The panel must not turn "I could not read the type" into "your view is wrong".
  assert.deepEqual(checkOrderBy("anything", null), { ok: true });
  assert.equal(declaredSortFields({}), null);
  assert.equal(declaredSortFields({ fields: [] }), null);
  assert.equal(declaredSortFields({ fields: "nope" }), null);
  assert.equal(declaredSortFields(null), null);
});

test("the field list is the type's own names, and junk is skipped", () => {
  assert.deepEqual(declared, ["name", "owner", "priority", "remarks"]);
  assert.deepEqual(declaredSortFields({ fields: [{ label: "无名字" }, { name: "ok" }] }), ["ok"]);
  assert.deepEqual(declaredSortFields({ fields: [{ name: "" }, { name: 3 }, { name: "ok" }] }), ["ok"]);
});

// ---------------------------------------------------------------------------
// Multi-key `orderBy` (SSR-000066 rev20): every key is checked, and a refusal
// names the key that failed — "one of your keys is wrong" is not actionable.
// ---------------------------------------------------------------------------

test("every key of a list is accepted when all of them exist", () => {
  assert.deepEqual(checkOrderBy(["priority", "modified_at"], declared), { ok: true });
  assert.deepEqual(checkOrderBy(["key", "state", "owner"], declared), { ok: true });
});

test("the second key is checked, and the message names it by position and name", () => {
  const verdict = checkOrderBy(["priority", "modifed_at"], declared);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /orderBy 第 2 个键/);
  assert.match(verdict.error, /「modifed_at」/);
  assert.doesNotMatch(verdict.error, /「priority」/, "the valid key must not be blamed");
  // Same 'what exists' trailer as the single-key message.
  assert.match(verdict.error, /可用：/);
  assert.match(verdict.error, /modifiedAt/);
});

test("a bad later key is found even when the first key is unknown too", () => {
  // The report is about the first failing key, in configured order: fixing the
  // list top-down is what an author does.
  const verdict = checkOrderBy(["nope", "also_nope"], declared);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /orderBy 第 1 个键/);
});

test("an empty list sorts by nothing and is never refused", () => {
  assert.deepEqual(checkOrderBy([], declared), { ok: true });
  assert.deepEqual(checkOrderBy([], null), { ok: true });
});

test("failing open applies to lists too: unreadable metadata abstains", () => {
  assert.deepEqual(checkOrderBy(["priority", "modifed_at"], null), { ok: true });
});
