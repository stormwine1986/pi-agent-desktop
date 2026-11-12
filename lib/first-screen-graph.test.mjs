import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// TASK-000108 → TASK-000110 → TASK-000113.
//
// The desktop shell keeps its window hidden until the page reports `app_ready`
// (`components/desktop/useReportDesktopReady.ts`), and `app_ready` waits for the
// first screen's data. The pi SDK is server-external, so one *static* symbol from
// `@earendil-works/*` loads a 37 MB ESM graph — 1.4–2.3 s of blocked event loop
// inside the packaged Node. Moving that cost from one request to the next is
// exactly what made the first two attempts fail: the identity probe, then
// `GET /api/sessions`, then `GET /api/sessions/[id]`, then `GET /api/custom-css`,
// each measured paying the same ~1.4–2 s while `main window revealed` did not
// move (server.log "event loop blocked for …" on every cold start).
//
// Rule: **every route the first screen requests before `app_ready` answers**
// must be statically free of the SDK. Type-only imports are erased by the
// compiler and stay allowed. A route that genuinely needs the SDK keeps it
// behind `await import(...)` at the point of use, which is a deliberate,
// measured decision for that request — not something that happens by import.
//
// The list below is the measured inventory (docs/agents/first-screen-requests.md):
// a real cold start with `PI_FIRST_SCREEN_PROBE=1` on the packaged app, requests
// up to `main window revealed` in desktop.log. The inventory test at the end
// fails when a route in that document is not walked here, so a new first-screen
// request cannot silently opt out of the rule.
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[\s\S]*?)\bfrom\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;

/** Routes that answer a request the first screen makes before `app_ready`. */
export const FIRST_SCREEN_ROUTES = [
  "app/api/desktop/identity/route.ts",
  "app/api/custom-css/route.ts",
  "app/api/scheduled-tasks/route.ts",
  "app/api/push/config/route.ts",
  "app/api/sessions/route.ts",
  "app/api/appearance/fonts/route.ts",
  "app/api/home/route.ts",
  "app/api/chat-workspace/route.ts",
  "app/api/scheduled-tasks/events/route.ts",
  "app/api/agent/running/events/route.ts",
  "app/api/events/subscriptions/route.ts",
  "app/api/worktrees/route.ts",
  "app/api/cwd/status/route.ts",
  "app/api/views/route.ts",
  "app/api/project-trust/route.ts",
  "app/api/sessions/[id]/route.ts",
  // Not only the read sibling: `/context` pages history in and `/state` follows
  // the history read, both inside the same screen.
  "app/api/sessions/[id]/context/route.ts",
  "app/api/sessions/[id]/state/route.ts",
  "app/api/agent/[id]/events/route.ts",
  // Measured *after* the reveal in the restore scenario, kept in the rule so a
  // new caller of the model list cannot start paying the SDK there silently.
  // It is static-free; the SDK it needs is imported when the catalogue is built.
  "app/api/models/route.ts",
];

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

/** Every file reachable from `entry` through static imports (type-only excluded). */
export function staticImportGraph(entry) {
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
  return { visited, offenders };
}

for (const route of FIRST_SCREEN_ROUTES) {
  test(`the first-screen route ${route} never imports the pi SDK statically`, () => {
    const { offenders } = staticImportGraph(join(rootDir, route));
    assert.deepEqual(
      offenders,
      [],
      `${route} answers a request the first screen makes before the window is shown; keep the SDK behind an await import() at the point of use`,
    );
  });
}

test("the walk really covers the graph that answers the session-completion request", () => {
  // A guard that cannot fail is no guard: these modules must be *in* the walk,
  // and the two SDK-backed halves must be out of it by name, so a failure above
  // reads as "you re-imported the runtime", not "some import got shorter".
  const { visited } = staticImportGraph(join(rootDir, "app/api/sessions/[id]/route.ts"));
  for (const expected of [
    "lib/session-read.ts",
    "lib/session-context.ts",
    "lib/session-list.ts",
    "lib/session-registry.ts",
    "lib/session-slim-entries.ts",
    "lib/subagents.ts",
    "lib/project-tree.ts",
    "lib/perf.ts",
  ]) {
    assert.ok(visited.has(join(rootDir, expected)), `${expected} should be part of the first-screen session graph`);
  }
  for (const forbidden of ["lib/session-reader.ts", "lib/rpc-manager.ts", "lib/session-slim-load.ts"]) {
    assert.ok(
      !visited.has(join(rootDir, forbidden)),
      `${forbidden} must not be reachable from the first-screen session request`,
    );
  }
});

test("the SDK-free halves stay free of the SDK they were split from", () => {
  for (const modulePath of [
    "lib/session-list.ts",
    "lib/session-read.ts",
    "lib/session-context.ts",
    "lib/session-registry.ts",
    "lib/session-slim-entries.ts",
    "lib/pi-trust-store.ts",
  ]) {
    const source = readFileSync(join(rootDir, modulePath), "utf8");
    const specifiers = [...source.matchAll(STATIC_IMPORT), ...source.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[1]);
    assert.deepEqual(
      specifiers.filter((specifier) => specifier.startsWith("@earendil-works/")),
      [],
      `${modulePath} answers the first screen; it must not import the SDK statically`,
    );
  }
});

test("the guard covers every route the inventory document names", () => {
  // docs/agents/first-screen-requests.md is the measured list (request → route →
  // SDK reachability → TTFB → largest stall). A route added there without a
  // guard entry, or removed from the guard while the document still names it,
  // fails here — that is how the next landing spot gets caught before a release.
  const doc = readFileSync(join(rootDir, "docs/agents/first-screen-requests.md"), "utf8");
  const routes = new Set(
    [...doc.matchAll(/`(app\/api\/[^`]+?)`/g)]
      .map((match) => match[1])
      .filter((path) => path.endsWith("/route.ts")),
  );
  assert.ok(routes.size >= 15, `expected the inventory to name the routes it measured, found ${routes.size}`);
  const guarded = new Set(FIRST_SCREEN_ROUTES);
  for (const route of routes) {
    assert.ok(guarded.has(route), `${route} is in the first-screen inventory but not in FIRST_SCREEN_ROUTES`);
  }
});

// ---------------------------------------------------------------------------
// DEFECT-000101: requests that arrive *after* the reveal and still froze the app.
// ---------------------------------------------------------------------------
//
// The inventory above answers a different question ("may this request *load* the
// SDK statically?"). The 0.10.0 cold starts showed the next failure mode: a
// request that arrives a few seconds after the window is up and pays the SDK's
// ~2.7 s module load with a deliberate `await import()`, which is a frozen app for
// as long as it runs (`event loop blocked for 2751–2999 ms`, six out of six).
// A deliberate dynamic import is fine while the window is hidden; after the
// reveal that work has to leave the thread instead.
//
// So these routes owe a second assertion: no runtime SDK specifier anywhere in
// their static graph (static *or* dynamic), and the SDK work reachable only
// through the worker's own source.
export const OFF_THREAD_ROUTES = {
  "app/api/models/route.ts": {
    // The measured cost this replaces, for the failure message.
    why: "the composer's model list; building it blocked the loop for 2.6–2.9 s after the window appeared (DEFECT-000101)",
    worker: "lib/models-worker.ts",
    /** The worker's body: a string the worker evaluates, not an import of this thread. */
    workerSource: "lib/models-worker-source.ts",
  },
};

const DYNAMIC_SDK_IMPORT = /import\(\s*["'](@earendil-works\/[^"']+)["']\s*\)/g;

/**
 * Line and block comments removed, so a comment *about* the defect (this file's
 * neighbours are full of them) cannot fail the walk. `lib/pi-sdk-internals.ts`
 * names the bare specifier in prose precisely to explain why it is not used.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

for (const [route, { why, worker, workerSource }] of Object.entries(OFF_THREAD_ROUTES)) {
  test(`${route} does not pay the SDK on the server thread (${why})`, () => {
    const { visited, offenders: staticOffenders } = staticImportGraph(join(rootDir, route));
    const offenders = [...staticOffenders];
    for (const [file, source] of visited) {
      // The worker body is code for another thread; its specifiers are the point.
      if (file === join(rootDir, workerSource)) continue;
      for (const match of withoutComments(source).matchAll(DYNAMIC_SDK_IMPORT)) {
        offenders.push(`${relative(rootDir, file)} loads ${match[1]} at run time`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `${route} answers a request that lands while the user is already interacting; move the SDK work to ${worker}, which runs it in a worker thread`,
    );
    // …and the walk has to reach that worker, or "no SDK in the graph" would be
    // satisfied by simply dropping the feature.
    assert.ok(
      visited.has(join(rootDir, worker)),
      `${route} must build its data through ${worker}`,
    );
  });
}
