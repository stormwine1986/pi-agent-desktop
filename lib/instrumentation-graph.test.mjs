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
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

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

// DEFECT-000100 / TASK-000170. "Behind a dynamic import" was not enough for the
// event runtime: `startEventRuntime()` scans 2 s after the hook, which is still
// inside the window the desktop shell waits on (`listening → serving`), and the
// scan's first lazy import was `../session-reader` — the SDK-backed half, whose
// module load is 1.5–2.3 s of blocked event loop in the packaged Node. Measured
// on the installed payload, same build, only `PI_WEB_DISABLE_EVENTS` differing:
// on `event loop blocked for 3651 ms`, off no stall line. A lazy import the scan
// always performs *is* a startup import; the point of deferring it was the wall
// clock, and the wall clock says the scan is on the critical path.
//
// Rule: every module the event runtime imports lazily must itself be SDK-free,
// and the SDK-backed halves must not appear in it by name. Delivery
// (`lib/events/delivery.ts`) keeps its own doors — it runs when a batch is
// actually delivered, not on the first scan.
test("the event runtime's lazy imports never load the pi SDK", () => {
  const relativeFile = "lib/events/runtime.ts";
  const runtimeFile = join(rootDir, relativeFile);
  const lazy = [...readFileSync(runtimeFile, "utf8").matchAll(DYNAMIC_IMPORT)].map((match) => match[1]);
  assert.ok(lazy.length >= 2, "expected the runtime to import its dependencies lazily");

  assertNoSdkDoor(relativeFile, lazy, ["../session-reader", "../rpc-manager"], "../session-list");
  assert.deepEqual(
    lazySdkOffenders(relativeFile, runtimeFile, lazy),
    [],
    "the first event scan must not pay the SDK's module load",
  );
});

// DEFECT-000100 / TASK-000172. The same wall clock applies one tick earlier, to
// the watch pump: `registerNodeInstrumentation()` calls `startWatchPump()`, and
// the pump's *first* tick runs immediately (`void tick()`), not on the minute.
// That tick's first lazy import was `../../session-reader`, so the SDK's 1.5–2.3 s
// module load landed at ≈ +1 s — before the event runtime's +2 s scan, and inside
// the `listening → serving` window the desktop shell waits on. Measured on the
// isolated payload with only the watch pump enabled: `event loop blocked for …`
// at ≈ +1 s, gone once this import was redirected at the SDK-free catalogue
// (`lib/session-list.ts` re-exports the same `listAllSessions`).
//
// `lib/views/watch/runtime.ts` keeps its own `../../session-reader` door: it is
// reached from `startWatchSession()`, i.e. when a claimed item is actually
// dispatched, which is neither the startup path nor a module the first tick
// loads. Turning that one into a dynamic import would not save the startup
// anything, so it is deliberately left alone.
test("the watch pump's first tick never loads the pi SDK", () => {
  const relativeFile = "lib/views/watch/index.ts";
  const watchFile = join(rootDir, relativeFile);
  const lazy = [...readFileSync(watchFile, "utf8").matchAll(DYNAMIC_IMPORT)].map((match) => match[1]);
  assert.ok(lazy.length >= 1, "expected the pump to import its project sources lazily");

  assertNoSdkDoor(relativeFile, lazy, ["../../session-reader", "../../rpc-manager"], "../../session-list");
  assert.deepEqual(
    lazySdkOffenders(relativeFile, watchFile, lazy),
    [],
    "the watch pump's immediate first tick must not pay the SDK's module load",
  );
});

// DEFECT-000104 / TASK-000214. Deferring the first round (see
// `lib/first-screen-gate.ts`) is what keeps the *first screen* clean, but the
// round itself still has to be cheap: the pump asks `projectBusy` for every
// watched view of every visible project before it dispatches anything, and that
// gate used to be `await import("../../rpc-manager")` — the 37 MB graph, on the
// very first round, for a question the SDK-free registry already answers
// (`lib/session-registry.ts` reads the wrappers rpc-manager owns).
//
// Measured on the packaged payload with a five-view fixture board: the round's
// first SDK load was a 2779 ms event-loop block right after `/api/sessions`
// (profile: ESM resolution/instantiation of `@earendil-works/*`, ~3.2 s of the
// window, `internalModuleStat`/`getPackageScopeConfig` dominating); with
// `PI_WEB_DISABLE_WATCH=1` the same start had no stall over 500 ms.
//
// Rule: the gate path may not reach `rpc-manager`, not even lazily. Starting a
// session still does — that is the item actually being dispatched.
test("the watch pump's dispatch gate does not load the agent runtime", () => {
  const relativeFile = "lib/views/watch/runtime.ts";
  const source = readFileSync(join(rootDir, relativeFile), "utf8");
  const gate = /async projectBusy\(runCwd\) \{[\s\S]*?\n    \},/.exec(source);
  assert.ok(gate, "projectBusy must still be in lib/views/watch/runtime.ts");
  assert.match(gate[0], /hasBusyRpcSessionForCwd\(runCwd\)/);
  const gateCode = gate[0]
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(gateCode, /\bimport\(/, "the gate must not import the agent runtime");
  assert.doesNotMatch(gateCode, /rpc-manager/);
  assert.match(
    source,
    /import \{ hasBusyRpcSessionForCwd \} from "\.\.\/\.\.\/session-registry"/,
    "the SDK-free registry is where this answer comes from",
  );
});

/** The SDK-backed halves by name, so the failure says what to import instead. */
function assertNoSdkDoor(relativeFile, lazy, sdkDoors, replacement) {
  for (const specifier of lazy) {
    assert.ok(
      !sdkDoors.includes(specifier),
      `${relativeFile} imports ${specifier} on its startup path; that module loads the pi SDK ` +
        `(DEFECT-000100). Import ${replacement} instead.`,
    );
  }
}

/** Every `@earendil-works/*` module reachable from a lazy import's static graph. */
function lazySdkOffenders(relativeFile, fromFile, lazy) {
  const offenders = [];
  for (const specifier of lazy) {
    const resolved = resolveSpecifier(specifier, fromFile);
    if (!resolved) continue;
    // The lazy target plus everything it imports statically: that whole graph
    // loads the moment the scan asks for one symbol from it.
    const visited = new Set();
    const queue = [resolved];
    while (queue.length) {
      const file = queue.pop();
      if (visited.has(file)) continue;
      visited.add(file);
      const fileSource = readFileSync(file, "utf8");
      const staticSpecifiers = [...fileSource.matchAll(STATIC_IMPORT), ...fileSource.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[1]);
      for (const next of staticSpecifiers) {
        if (next.startsWith("@earendil-works/")) {
          offenders.push(`${relativeFile} imports ${specifier}, which imports ${next} (via ${relative(rootDir, file)})`);
          continue;
        }
        const nextFile = resolveSpecifier(next, file);
        if (nextFile) queue.push(nextFile);
      }
    }
  }
  return offenders;
}
