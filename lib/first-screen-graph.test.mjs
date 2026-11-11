import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// TASK-000110 / DEFECT-000090. `GET /api/sessions` is the first data request a
// cold start makes; the desktop shell keeps its window hidden until the first
// screen has that data (`components/desktop/useReportDesktopReady.ts`). The pi
// SDK is server-external, so one static symbol from it loads a 37 MB ESM graph
// (~1.4–1.5 s of blocked event loop inside the packaged Node) — measured on
// that request before this split.
//
// Rule: nothing this route imports *statically* may reach
// `@earendil-works/*`. Type-only imports are erased by the compiler and stay
// allowed; the SDK's own needs belong behind a module that request does not
// load (`lib/session-reader.ts` for SessionManager, `lib/rpc-manager.ts` for
// the agent runtime) or behind `lib/agent-dir.ts`, which resolves pi's paths
// without the SDK.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(rootDir, "app/api/sessions/route.ts");

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

test("the first-screen sessions request never imports the pi SDK statically", () => {
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

  assert.deepEqual(
    offenders,
    [],
    "the first data request of a cold start must not load the pi SDK; move the SDK use behind lib/session-reader.ts / lib/rpc-manager.ts and resolve paths through lib/agent-dir.ts",
  );
  // Sanity: the walk really covered the graph that answers this request.
  for (const expected of [
    "lib/session-list.ts",
    "lib/session-registry.ts",
    "lib/session-list-scanner.ts",
    "lib/chat-workspace.ts",
    "lib/scheduled-tasks/run-index.ts",
    "lib/file-access.ts",
    "lib/perf.ts",
  ]) {
    assert.ok(visited.has(join(rootDir, expected)), `${expected} should be part of the first-screen graph`);
  }
  // The two SDK-backed modules must stay *out* of it — naming them makes the
  // failure above read as "you re-imported the runtime", not "some import got
  // shorter".
  for (const forbidden of ["lib/session-reader.ts", "lib/rpc-manager.ts"]) {
    assert.ok(!visited.has(join(rootDir, forbidden)), `${forbidden} must not be reachable from the first-screen request`);
  }
});

test("the SDK-free session-list half stays free of the SDK it was split from", () => {
  const source = readFileSync(join(rootDir, "lib/session-list.ts"), "utf8");
  const specifiers = [...source.matchAll(STATIC_IMPORT), ...source.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[1]);
  assert.deepEqual(
    specifiers.filter((specifier) => specifier.startsWith("@earendil-works/")),
    [],
    "lib/session-list.ts answers the first-screen catalogue; it must resolve pi paths through lib/agent-dir.ts",
  );
});
