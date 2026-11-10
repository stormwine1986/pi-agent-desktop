import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { StaleDependencyNotice } = await jiti.import("./StaleDependencyNotice.tsx");
const { staleDependencies } = await jiti.import("../lib/entity-dependencies.ts");
const noticeSource = (await readFile(new URL("./StaleDependencyNotice.tsx", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const panelSource = (await readFile(new URL("./EntityPanel.tsx", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

const h = React.createElement;

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

const lifecycle = {
  routes: [
    {
      from: "DRAFT",
      to: "DEFINED",
      guard: "all(depends_on, it.state in ['FINISHED', 'INVALID'])",
      guard_description: "依赖的任务必须都已完成或已作废",
    },
  ],
};

const depRow = (state) => ({
  key: "TASK-000040",
  type: "TASK",
  name: "被依赖的任务",
  state,
  linkType: "depends_on",
});

const render = (input) =>
  renderToStaticMarkup(h(StaleDependencyNotice, { items: staleDependencies(input) }));

test("unsatisfied: the detail view says which dependency broke and what it needs", () => {
  const html = render({ state: "DRAFT", lifecycle, upstream: [depRow("DRAFT")] });
  const text = textOf(html);
  assert.equal(text, "依赖已失效：TASK-000040 当前 DRAFT（需要 FINISHED / INVALID）");
  // A notice is a notice: it does not disable the form or the transitions.
  assert.equal(html.includes("disabled"), false);
});

test("satisfied: nothing is rendered at all", () => {
  assert.equal(render({ state: "DRAFT", lifecycle, upstream: [depRow("FINISHED")] }), "");
});

test("no dependencies: nothing is rendered, not even a quiet “no problems” row", () => {
  assert.equal(render({ state: "DRAFT", lifecycle, upstream: [] }), "");
});

test("empty relations: a read that reported nothing, or no guard at all, renders nothing", () => {
  assert.equal(renderToStaticMarkup(h(StaleDependencyNotice, { items: [] })), "");
  assert.equal(render({ state: "DRAFT", lifecycle: null }), "");
  assert.equal(render({ state: "DRAFT", lifecycle: { routes: [] }, upstream: [depRow("DRAFT")] }), "");
});

test("the rendered text carries no internal vocabulary", () => {
  const text = textOf(render({ state: "DRAFT", lifecycle, upstream: [depRow("DRAFT")] }));
  for (const term of ["guard", "STATE_GUARD_", "it.state", "depends_on", "suspect"]) {
    assert.equal(text.includes(term), false, `the notice must not show ${term}`);
  }
});

test("rendering a notice issues no request and has no write path", () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args[0]);
    throw new Error("rendering the notice must not call fetch");
  };
  try {
    const html = render({ state: "DRAFT", lifecycle, upstream: [depRow("DRAFT")] });
    assert.match(html, /依赖已失效/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, []);
  // The component may only render what it is handed: no endpoint, no mutation verb,
  // no `suspect` — the second fact `AC-11` explicitly refuses to write. Comments are
  // stripped first, so the assertion is about what the code can do.
  const noticeCode = noticeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["fetch(", "/api/", "POST", "PUT", "DELETE", "suspect", "promotion", "list_traces"]) {
    assert.equal(noticeCode.includes(forbidden), false, `StaleDependencyNotice must not contain ${forbidden}`);
  }
});

test("the panel computes the notice from its own reads and renders it above the tabs", () => {
  assert.match(panelSource, /staleDependencies\(\{/);
  assert.match(panelSource, /upstream: traces\?\.upstream \?\? \[\]/);
  assert.match(panelSource, /<StaleDependencyNotice items=\{stale\} \/>/);
  // Placed before the tablist, so the warning is visible on both views.
  assert.ok(
    panelSource.indexOf("<StaleDependencyNotice") < panelSource.indexOf('role="tablist"'),
    "the notice belongs above the tabs",
  );
});
