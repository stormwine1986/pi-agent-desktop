import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { EntityAttachmentUploads } = await jiti.import("./EntityAttachmentUploads.tsx");

const h = React.createElement;

// SSR-000126 AC-2 / AC-3 / AC-7: which entries appear, in which order, and which
// of them are unusable — and why. The panel delegates all of that to
// `attachmentUploadEntries` and only renders the verdict, so these tests are
// about the rendering contract: no entry for `role`, a stated reason for `state`
// and `multiple`, and the declaration's own rules on every row.
function textOf(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** The markup of one entry row, so "no entry" means no row at all. */
function rowOf(html, key) {
  const marker = `data-attachment-upload="${key}"`;
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const next = html.indexOf("data-attachment-upload=", start + marker.length);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

function category(overrides = {}) {
  return {
    key: "note",
    label: "备注附件",
    declared: true,
    multiple: true,
    contentTypes: [],
    maxSizeMb: null,
    uploadable: true,
    blockedBy: null,
    ...overrides,
  };
}

function entry(overrides = {}, activeCount = 0) {
  return { category: category(), blocked: null, activeCount, ...overrides };
}

const render = (entries, extra = {}) =>
  renderToStaticMarkup(h(EntityAttachmentUploads, {
    entries,
    busy: null,
    disabled: false,
    onSelect: () => {},
    ...extra,
  }));

test("one entry per declared category, in declaration order", () => {
  const html = render([
    entry({ category: category({ key: "evidence", label: "取证材料", contentTypes: ["application/pdf"], maxSizeMb: 20 }) }),
    entry({ category: category({ key: "note", label: "备注" }) }),
    entry({ category: category({ key: "default", label: "默认附件", declared: false }) }),
  ]);
  const order = [...html.matchAll(/data-attachment-upload="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ["evidence", "note", "default"]);
  const text = textOf(html);
  // The declaration's own rules are visible before a file is picked.
  assert.match(text, /取证材料/);
  assert.match(text, /类型 application\/pdf/);
  assert.match(text, /上限 20\.0 MB/);
  assert.match(text, /默认附件/);
  // Every usable entry has a picker carrying the category's own `accept`.
  assert.match(rowOf(html, "evidence"), /type="file"/);
  assert.match(rowOf(html, "evidence"), /accept="application\/pdf"/);
  assert.match(rowOf(html, "note"), /type="file"/);
  assert.doesNotMatch(rowOf(html, "note"), /accept=/);
});

test("a role-less category gets no entry at all, not a disabled one", () => {
  const html = render([
    entry({ category: category({ key: "note" }) }),
    entry({ blocked: "role", category: category({ key: "solution", label: "解决方案附件" }) }),
  ]);
  assert.equal(rowOf(html, "solution"), null);
  assert.doesNotMatch(textOf(html), /解决方案附件/);
  assert.match(rowOf(html, "note"), /type="file"/);
});

test("a state-frozen category is stated, not discovered after a click", () => {
  const html = render([
    entry({ blocked: "state", category: category({ key: "solution", label: "解决方案附件", multiple: false }) }),
  ]);
  const row = rowOf(html, "solution");
  assert.match(textOf(row), /当前状态只读/);
  // No picker: there is nothing this reader could do with it in this state.
  assert.doesNotMatch(row, /type="file"/);
});

test("multiple:false with an active attachment says why, and offers no picker", () => {
  const html = render([
    entry({ blocked: "multiple", activeCount: 1, category: category({ key: "solution", multiple: false }) }),
  ]);
  const text = textOf(rowOf(html, "solution"));
  assert.match(text, /只允许一个活跃附件，已有 1 个/);
  assert.doesNotMatch(rowOf(html, "solution"), /type="file"/);
  // A one-only category with nothing bound still says so up front.
  const free = render([entry({ category: category({ key: "solution", multiple: false }) })]);
  assert.match(textOf(rowOf(free, "solution")), /只能一个/);
  assert.match(rowOf(free, "solution"), /type="file"/);
});

test("the busy state names the step and takes the picker away", () => {
  const content = render([entry()], { busy: { category: "note", step: "content" } });
  assert.match(textOf(content), /传内容中…/);
  // A second click cannot start a second upload: the picker is disabled.
  assert.match(rowOf(content, "note"), /type="file"[^>]*disabled=""/);

  const bind = render([entry()], { busy: { category: "note", step: "bind" } });
  assert.match(textOf(bind), /绑定中…/);
});

test("nothing is rendered when there is no entry to offer", () => {
  assert.equal(render([]), "");
});
