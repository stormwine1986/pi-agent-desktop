import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { groupViews } = await jiti.import("./group.ts");

const view = (group) => ({ group });

test("declared groups come first, in the order the file declares them", () => {
  // SSR-000087 AC-6: declaring [B, A] must win over the order the views appear in.
  const grouped = groupViews(
    [view("A"), view("A"), view("B")],
    [
      { title: "B", collapsed: false },
      { title: "A", collapsed: false },
    ],
  );
  assert.deepEqual(grouped.ordered, ["B", "A"]);
  assert.deepEqual(grouped.members.get("A"), [0, 1]);
  assert.deepEqual(grouped.members.get("B"), [2]);
});

test("a group a view names without declaring is appended after the declared ones", () => {
  const grouped = groupViews(
    [view("未声明"), view("已声明")],
    [{ title: "已声明", collapsed: false }],
  );
  assert.deepEqual(grouped.ordered, ["已声明", "未声明"]);
});

test("a declared group with no views is not drawn", () => {
  const grouped = groupViews([view("A")], [
    { title: "A", collapsed: false },
    { title: "空组", collapsed: true },
  ]);
  assert.deepEqual(grouped.ordered, ["A"]);
});

test("ungrouped views are collected separately and keep their order", () => {
  const grouped = groupViews([view(null), view("A"), view(null)], [{ title: "A", collapsed: false }]);
  assert.deepEqual(grouped.ungrouped, [0, 2]);
  assert.deepEqual(grouped.ordered, ["A"]);
});

test("a view lands in exactly one group", () => {
  const grouped = groupViews([view("A"), view("B")], []);
  const all = [...grouped.members.values()].flat();
  assert.deepEqual(all.sort((a, b) => a - b), [0, 1]);
  assert.equal(new Set(all).size, all.length);
});
