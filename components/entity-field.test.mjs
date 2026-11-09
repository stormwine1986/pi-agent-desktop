import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// The alias mirrors tsconfig's `@/*`: FieldControl now renders the shared
// AppSelect, which reaches lib/ime through `@/lib/ime`.
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  jsx: { runtime: "automatic" },
  alias: { "@": process.cwd() },
});
const {
  propertyColumns,
  tableRows,
  tableDraftRows,
  emptyTableRow,
  serializeTableRows,
  isTableProperty,
  propertyType,
  // `FM-RENDER` AC-4: a field type the panel does not know must not be edited
  // through a text box that pretends to understand it.
  FieldControl,
  fieldControlOf,
  fieldDescriptorsOf,
  FIELD_CONTROLS,
} = await jiti.import("./entity-field.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");

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

const control = (property, value = "x") => renderToStaticMarkup(
  React.createElement(FieldControl, { property, value, onChange() {} }),
);

test("every type the base declares has an editor", () => {
  // The base's closed set (SSR-000053 DAT-SCHEMA), so a missing entry here means
  // a valid type renders read-only.
  for (const type of ["text", "shorttext", "number", "date", "datetime", "choice", "state", "user", "table"]) {
    assert.notEqual(fieldControlOf({ name: "f", type }), null, type);
  }
  assert.equal(Object.keys(FIELD_CONTROLS).length, 9);
});

test("a type the panel does not know is read-only and names itself", () => {
  const html = control({ name: "signature", label: "签名", type: "quantum-note" });
  assert.match(html, /readonly/i, "the value must not be editable");
  assert.match(html, /role="alert"/);
  assert.match(html, /quantum-note/);
  assert.match(html, /signature/);
  assert.doesNotMatch(html, /<textarea/);
});

test("a field with no declared type is called out, not guessed", () => {
  const html = control({ name: "mystery" });
  assert.match(html, /role="alert"/);
  assert.match(html, /未声明/);
});

test("known types still get their own editors", () => {
  assert.doesNotMatch(control({ name: "title", type: "shorttext" }), /role="alert"/);
  assert.match(control({ name: "notes", type: "text" }), /<textarea/);
  assert.match(control({ name: "n", type: "number" }), /type="number"/);
  assert.match(control({ name: "d", type: "date" }), /type="date"/);
  // A choice renders the shared app menu picker, not a native <select>
  // (AGENTS: form options go through components/AppSelect.tsx, which keeps the
  // popup on the .app-menu surface). Its options only exist while the menu is
  // open, so the SSR markup shows the trigger: combobox role, the field's own
  // label, and the current value.
  const choice = control({ name: "p", type: "choice", validValues: ["高", "低"] }, "高");
  assert.match(choice, /role="combobox"/);
  assert.match(choice, /class="app-select-trigger"/);
  assert.match(choice, /aria-label="p"/);
  assert.match(choice, />高</);
  // Radix keeps one hidden native <select> for form submission; nothing native
  // is *offered*.
  const nativeSelects = choice.match(/<select[^>]*>/g) ?? [];
  assert.equal(nativeSelects.every((tag) => tag.includes('aria-hidden="true"')), true);
});

test("a choice with no declared options is read-only, not free text", () => {
  // Broken metadata must not turn into "type anything": the form would then
  // write a value the model does not have.
  const html = control({ name: "priority", label: "优先级", type: "choice", validValues: [] });
  assert.match(html, /role="alert"/);
  assert.match(html, /枚举取值为空/);
  assert.match(html, /priority/);
  assert.match(html, /readonly/i);
  assert.doesNotMatch(html, /<select|<textarea/);
});

// `FM-RENDER` AC-1: the form's field list against `get_metadata`, item by item.
test("the form's field list is the metadata's, item by item", () => {
  const metadata = {
    fields: [
      { name: "name", label: "标题", type: "shorttext", required: true, isGloballyRequired: true },
      { name: "priority", label: "优先级", type: "choice", validValues: ["高", "中", "低"] },
      { name: "steps", label: "步骤", type: "table", columns: [{ name: "step" }, { name: "expect" }] },
      { name: "description", type: "text", requiredStates: ["DEFINED"] },
      { name: "signature", label: "签名", type: "quantum-note" },
    ],
  };
  const descriptors = fieldDescriptorsOf(metadata.fields);

  assert.deepEqual(descriptors.map((field) => field.name), metadata.fields.map((field) => field.name));
  for (const [index, field] of descriptors.entries()) {
    const declared = metadata.fields[index];
    // Nothing interpreted: label / type / options are the declared values.
    assert.equal(field.label, typeof declared.label === "string" ? declared.label : "");
    assert.equal(field.type, declared.type);
    assert.deepEqual(field.validValues, Array.isArray(declared.validValues) ? declared.validValues : []);
    // Nothing dropped: the entry travels verbatim, so flags we do not read
    // (required, requiredStates, columns) stay available to whoever does.
    assert.equal(field.property, declared);
  }
  assert.equal(descriptors[3].label, "", "a field with no label declares none");

  // And what the reader sees comes out of exactly those declarations.
  // The choice field is the shared picker; its declared options reach it through
  // the descriptor asserted above, and the trigger carries the field's label.
  const choiceField = control(descriptors[1].property);
  assert.match(choiceField, /class="app-select-trigger"/);
  assert.match(choiceField, /aria-label="优先级"/);
  assert.match(control(descriptors[3].property), /<textarea/);
  assert.match(control(descriptors[4].property), /role="alert"/);
});

test("a metadata entry with no name is skipped, never shown unlabelled", () => {
  const descriptors = fieldDescriptorsOf([{ label: "孤儿", type: "text" }, { name: "ok", type: "text" }]);
  assert.deepEqual(descriptors.map((field) => field.name), ["ok"]);
  assert.deepEqual(fieldDescriptorsOf(undefined), []);
  assert.deepEqual(fieldDescriptorsOf("nope"), []);
});
