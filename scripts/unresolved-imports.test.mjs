import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import { assertNoUnresolvedDynamicImports, findUnresolvedDynamicImports } from "./unresolved-imports.mjs";

// DEFECT-000092: webpack turns an unresolvable `import()` into a function that
// rejects with "Cannot find module", and the build looks fine. These fixtures
// are the two shapes it emits and the one message that must not trip the gate.
const STUB =
  'e=>{function f(e){return Promise.resolve().then(()=>{var f=Error("Cannot find module \'"+e+"\'");' +
  'throw f.code="MODULE_NOT_FOUND",f})}f.keys=()=>[],f.resolve=f,f.id=57930,e.exports=f}';
const NEXT_PAGE_NOT_FOUND =
  "class PageNotFoundError extends Error{constructor(a){super(),this.code=\"ENOENT\"," +
  "this.message=`Cannot find module for page: ${a}`}}";

async function withPayload(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-unresolved-imports-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeBundle(root, relativePath, source) {
  const path = join(root, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, source);
}

test("finds the placeholder in a dist dir and in a payload root", async () => {
  await withPayload(async (root) => {
    await writeBundle(root, ".next-desktop/server/chunks/2144.js", `var x=${STUB};`);
    await writeBundle(root, ".next-desktop/server/app/api/mcp/route.js", `var y=${STUB};`);

    const direct = await findUnresolvedDynamicImports([join(root, ".next-desktop")]);
    assert.deepEqual(
      direct.map(({ file }) => file.slice(file.indexOf("server")).split(sep).join("/")).sort(),
      ["server/app/api/mcp/route.js", "server/chunks/2144.js"],
    );

    // A staged payload root (what src-tauri/resources/server holds) nests the
    // dist dir one level down; both forms must be scanned.
    const staged = await findUnresolvedDynamicImports([root]);
    assert.equal(staged.length, 2);
    assert.ok(staged.every(({ occurrences }) => occurrences === 1));
  });
});

test("does not trip on Next's own 'Cannot find module for page' message", async () => {
  await withPayload(async (root) => {
    await writeBundle(root, ".next-desktop/server/chunks/2970.js", `class a{${NEXT_PAGE_NOT_FOUND}}`);
    await writeBundle(root, ".next-desktop/server/chunks/6644.js", `class b extends Error{constructor(a){super(),this.message=\`Cannot find module for page: \${a}\`}}`);
    await writeBundle(root, ".next-desktop/server/chunks/clean.js", "export const ok = 1;");

    assert.deepEqual(await findUnresolvedDynamicImports([root]), []);
    await assertNoUnresolvedDynamicImports([root]);
  });
});

test("ignores files outside a server bundle", async () => {
  await withPayload(async (root) => {
    // A browser build resolves ESM normally: the placeholder has no meaning
    // there, and a gate that fails on it would be noise.
    await writeBundle(root, ".next-desktop/static/chunks/main.js", `var x=${STUB};`);
    assert.deepEqual(await findUnresolvedDynamicImports([root]), []);
  });
});

test("the assertion names the files and how many placeholders each holds", async () => {
  await withPayload(async (root) => {
    await writeBundle(root, ".next-desktop/server/chunks/2144.js", `${STUB}${STUB}`);
    const error = await assertNoUnresolvedDynamicImports([root]).then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error instanceof Error);
    assert.match(error.message, /unresolved dynamic import placeholder/);
    assert.match(error.message, /chunks[\\/]2144\.js \(2\)/);
    assert.match(error.message, /DEFECT-000092/);
  });
});

test("a missing output directory is not an error", async () => {
  assert.deepEqual(await findUnresolvedDynamicImports([join(tmpdir(), "pi-web-does-not-exist-9f8e7d")]), []);
});
