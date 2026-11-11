import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// DEFECT-000090 / TASK-000108. Next calls the instrumentation hook as soon as
// the server is listening, and the desktop shell does not create its window
// until its identity probe has been answered. Anything that entry pulls in
// *synchronously* therefore sits in front of every cold start — and the pi SDK
// is server-external, so importing any one symbol from it loads a 37 MB ESM
// graph (measured at 1.4–2.3 s of blocked event loop inside the packaged Node).
//
// Rule: the startup graph may reach `@earendil-works/*` only through a dynamic
// import, i.e. when the thing that needs it actually runs. Type-only imports are
// erased by the compiler and stay allowed.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(rootDir, "instrumentation-node.ts");

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?)\bfrom\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;

function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith("@/")) return resolveAt(join(rootDir, specifier.slice(2)), fromFile);
  if (specifier.startsWith(".")) return resolveAt(resolve(dirname(fromFile), specifier), fromFile);
  return null;
}

function resolveAt(base, fromFile) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      /* try the next shape */
    }
  }
  throw new Error(`${relative(rootDir, fromFile)} imports ${relative(rootDir, base)}, which does not resolve`);
}

test("the instrumentation startup graph never imports the pi SDK statically", () => {
  const visited = new Map();
  const offenders = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    const source = readFileSync(file, "utf8");
    visited.set(file, source);
    const specifiers = [...source.matchAll(STATIC_IMPORT), ...source.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith("@earendil-works/")) {
        offenders.push(`${relative(rootDir, file)} imports ${specifier}`);
        continue;
      }
      const resolved = resolveSpecifier(specifier, file);
      if (resolved) queue.push(resolved);
    }
  }

  assert.deepEqual(offenders, [], "keep the SDK behind a dynamic import on this path");
  // Sanity: the walk really covered the graph the hook loads.
  for (const expected of ["lib/http-dispatcher.ts", "lib/scheduled-tasks/index.ts", "lib/views/watch/index.ts", "lib/events/runtime.ts", "lib/relay/runtime.ts"]) {
    assert.ok(visited.has(join(rootDir, expected)), `${expected} should be part of the startup graph`);
  }
});
