import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, jsx: { runtime: "automatic" } });
const {
  propertyColumns,
  tableRows,
  tableDraftRows,
  emptyTableRow,
  serializeTableRows,
  isTableProperty,
  propertyType,
} = await jiti.import("./entity-field.tsx");

const stepsProperty = {
  name: "steps",
  label: "测试步骤",
  type: "table",
  columns: [
    { name: "step", type: "text", required: true },
    { name: "expect", type: "text", required: false },
  ],
};

// The shape the base actually returns (TC-000016): rows carry their own id.
const stored = [
  { id: "row_a", step: "打开追溯图并勾选 TC", expect: "TC 列出现该节点" },
  { id: "row_b", step: "点亮 TC 的 head", expect: "只保留与 TC 连通的节点" },
];

test("a table field is recognised by its type, not by having columns", () => {
  assert.equal(isTableProperty(stepsProperty), true);
  assert.equal(isTableProperty({ name: "x", type: "text" }), false);
  assert.equal(propertyType(stepsProperty), "table");
});

test("columns come from metadata, in the declared order", () => {
  assert.deepEqual(propertyColumns(stepsProperty), ["step", "expect"]);
  assert.deepEqual(propertyColumns({ name: "x", type: "table" }), []);
});

test("rows keyed by column name line up with the header", () => {
  assert.deepEqual(tableRows(stored.slice(0, 1), ["step", "expect"]), [
    ["打开追溯图并勾选 TC", "TC 列出现该节点"],
  ]);
});

test("an undeclared key is dropped instead of shifting the columns", () => {
  assert.deepEqual(tableRows([{ step: "点开", expect: "看到", secret: "不该出现" }], ["step", "expect"]), [
    ["点开", "看到"],
  ]);
});

test("empty or unusable values render as no rows, not as JSON", () => {
  assert.deepEqual(tableRows(null, ["step"]), []);
  assert.deepEqual(tableRows("", ["step"]), []);
  assert.deepEqual(tableRows([], ["step"]), []);
});

test("editable rows keep their id and only the declared columns", () => {
  assert.deepEqual(tableDraftRows(stepsProperty, stored), [
    { step: "打开追溯图并勾选 TC", expect: "TC 列出现该节点", id: "row_a" },
    { step: "点亮 TC 的 head", expect: "只保留与 TC 连通的节点", id: "row_b" },
  ]);
});

test("an added row has no id — the base assigns one", () => {
  assert.deepEqual(emptyTableRow(stepsProperty), { step: "", expect: "" });
  assert.equal("id" in emptyTableRow(stepsProperty), false);
});

test("rows go back with id preserved and undeclared keys gone", () => {
  const rows = [
    { step: "a", expect: "b", id: "row_a", secret: "x" },
    { step: "c", expect: "" },
  ];
  assert.deepEqual(serializeTableRows(stepsProperty, rows), [
    { step: "a", expect: "b", id: "row_a" },
    { step: "c", expect: "" },
  ]);
});

test("a round trip of stored → draft → wire keeps the value", () => {
  const draft = tableDraftRows(stepsProperty, stored);
  assert.deepEqual(serializeTableRows(stepsProperty, draft), stored);
});

test("missing columns still produce wire rows rather than throwing", () => {
  const bare = { name: "x", type: "table" };
  assert.deepEqual(serializeTableRows(bare, [{ anything: "1", id: "row_z" }]), [{ id: "row_z" }]);
});
