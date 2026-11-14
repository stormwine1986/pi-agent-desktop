import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  MCP_LISTING_WORKER_TIMEOUT_MS,
  McpListingError,
  loadBuiltinSwitches,
  loadCodemodeMerges,
  loadMcpListingAnswer,
  loadMcpListingInternals,
  mcpListingFailure,
  mcpListingFailureBody,
  MCP_LISTING_WORKER_SOURCE,
} = await jiti.import("./mcp-listing-worker.ts");
const { importPiSdkInternals, sdkInternalsProbeReason, sdkInternalsProbeRequest } = await jiti.import("./pi-sdk-internals.ts");

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(rootDir, "lib/mcp-listing-worker.ts"), "utf8").replace(/\r\n/g, "\n");

/**
 * The listing worker's contract (TASK-000259): entries and values in, three
 * plain answers out, and a crash or a timeout reported as a coded failure
 * rather than an empty list.
 *
 * No real SDK load here — that is 1.7–4.9 s per run and is measured on the
 * packaged server instead (the trust request's stall against the same build's
 * pre-change arm). What these cases pin is the plumbing the route depends on.
 *
 * Run alone: `node --experimental-strip-types --test --test-force-exit
 * --test-timeout=20000 lib/mcp-listing-worker.test.mjs`.
 */

/** Answers the request from `workerData.table`, so a case controls every verdict. */
const TABLE_SOURCE = `
"use strict";
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ id, work }) => {
  parentPort.postMessage({
    id,
    ok: true,
    value: {
      validations: work.entries.map((entry) => {
        if (entry.name === "refused") return { kind: "error", message: "server \\"refused\\": legacy SSE transport is not supported" };
        if (entry.name === "empty") return { kind: "none" };
        return { kind: "config", config: { ...entry.value, exposure: "direct" } };
      }),
      values: work.values.map((text) => [text, text.startsWith("!"), text.startsWith("!") ? [] : ["FROM_" + text.length]]),
    },
  });
});
`;

const SILENT_SOURCE = `
"use strict";
require("node:worker_threads").parentPort.on("message", () => {});
`;

const FAILING_SOURCE = `
"use strict";
require("node:worker_threads").parentPort.on("message", (message) => {
  require("node:worker_threads").parentPort.postMessage({ id: message.id, ok: false, error: "the checks are not there" });
});
`;

const CRASHING_SOURCE = `
"use strict";
require("node:worker_threads").parentPort.on("message", () => { throw new Error("worker exploded"); });
`;

const work = {
  entries: [
    { name: "http", value: { url: "https://example.test/mcp" } },
    { name: "refused", value: { type: "sse", url: "https://legacy.test/sse" } },
    { name: "empty", value: {} },
  ],
  values: ["!echo hi", "${TOKEN}"],
};

test("the three checks come back for the data they were asked about", async () => {
  const internals = await loadMcpListingInternals(work, { source: TABLE_SOURCE, workerData: {} });
  assert.ok(internals);
  // The validator's answer travels as data: a config object, or its message.
  assert.deepEqual(internals.validateMcpServerConfig("http", { url: "https://example.test/mcp" }), {
    url: "https://example.test/mcp",
    exposure: "direct",
  });
  assert.equal(internals.validateMcpServerConfig("refused", { type: "sse", url: "https://legacy.test/sse" }), 'server "refused": legacy SSE transport is not supported');
  assert.equal(internals.validateMcpServerConfig("empty", {}), undefined);
  // And the two value parsers, by the value's own text.
  assert.equal(internals.isCommandConfigValue("!echo hi"), true);
  assert.deepEqual(internals.getConfigValueEnvVarNames("!echo hi"), []);
  assert.equal(internals.isCommandConfigValue("${TOKEN}"), false);
  assert.deepEqual(internals.getConfigValueEnvVarNames("${TOKEN}"), ["FROM_8"]);
});

test("a verdict this module did not ask for fails loudly instead of listing the entry unchecked", async () => {
  const internals = await loadMcpListingInternals(work, { source: TABLE_SOURCE, workerData: {} });
  assert.ok(internals);
  // Guessing here would describe an entry differently from how the SDK reads
  // it, which is the one thing the trust dialog must not do.
  assert.throws(() => internals.validateMcpServerConfig("never-asked", {}), McpListingError);
  assert.throws(() => internals.getConfigValueEnvVarNames("never asked for"), McpListingError);
});

test("a worker that refuses the request reports a coded, retriable failure", async () => {
  await assert.rejects(
    loadMcpListingInternals(work, { source: FAILING_SOURCE, workerData: {} }),
    (error) => {
      assert.equal(error.name, "McpListingError");
      assert.equal(error.code, "mcp-listing-worker-failed");
      assert.equal(error.retriable, true);
      assert.match(error.message, /the checks are not there/);
      return true;
    },
  );
});

test("a worker that dies mid-request reports the same failure", async () => {
  await assert.rejects(
    loadMcpListingInternals(work, { source: CRASHING_SOURCE, workerData: {} }),
    (error) => {
      assert.equal(error.code, "mcp-listing-worker-failed");
      assert.equal(error.retriable, true);
      return true;
    },
  );
});

test("a worker that never answers times out, and is dropped rather than trusted", async () => {
  await assert.rejects(
    loadMcpListingInternals(work, { source: SILENT_SOURCE, workerData: {}, timeoutMs: 150 }),
    (error) => {
      assert.equal(error.code, "mcp-listing-timeout");
      assert.equal(error.retriable, true);
      assert.match(error.message, /did not finish within 150 ms/);
      return true;
    },
  );
});

test("the route's answer for such a failure carries the code and never pretends the file is empty", () => {
  const body = mcpListingFailureBody(new McpListingError("mcp-listing-timeout", "listing did not finish within 30000 ms"));
  assert.deepEqual(body, {
    mcpServers: [],
    mcpError: "listing did not finish within 30000 ms",
    mcpErrorCode: "mcp-listing-timeout",
    mcpRetriable: true,
  });
  // `mcpFile` stays absent, which is what makes the dialog show a failure
  // rather than "the file declares no servers".
  assert.equal("mcpFile" in body, false);

  // Anything that is not this module's own failure keeps the old answer.
  assert.equal(mcpListingFailureBody(new Error("the project file was not read")), undefined);
  assert.equal(mcpListingFailure(new Error("boom")), undefined);
  assert.deepEqual(
    mcpListingFailure(Object.assign(new Error("from another bundle copy"), { name: "McpListingError", code: "mcp-listing-worker-failed", retriable: true })),
    { code: "mcp-listing-worker-failed", retriable: true },
    "a second copy of the class in the bundle still reports its code",
  );
});

test("an SDK that cannot be located lists the entries unchecked, as it always has", async () => {
  const previous = process.env.PI_PACKAGE_DIR;
  process.env.PI_PACKAGE_DIR = "D:/not-the-sdk";
  try {
    // Not an error answer: `loadPiSdkInternals()` has always degraded here, and
    // the listing shows every entry with `validated: false`.
    assert.equal(await loadMcpListingInternals(work, { workerData: undefined }), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_PACKAGE_DIR;
    else process.env.PI_PACKAGE_DIR = previous;
  }
});

test("the worker reads nothing and decides nothing", () => {
  // The task's boundary: the listing moves, no other read moves with it.
  assert.match(MCP_LISTING_WORKER_SOURCE, /worker_threads/);
  // No file content and no process: the one fs call is the internals probe's
  // `realpathSync()`, which canonicalizes the path the SDK's own `getPackageDir()`
  // answered — metadata, not bytes, and nothing of the user's.
  assert.doesNotMatch(MCP_LISTING_WORKER_SOURCE, /readFile|readdir|writeFile|createReadStream|node:child_process/);
  assert.match(MCP_LISTING_WORKER_SOURCE, /realpathSync\(getPackageDir\(\)\)/);
  // It answers the three checks and nothing else: no masking, no ordering, no
  // "which entry replaces which" — those stay in lib/mcp-config-read.ts.
  assert.doesNotMatch(MCP_LISTING_WORKER_SOURCE, /maskCommand|maskUrl|maskArgs|shadowedByProject|replacesGlobal|refuseAsLoaderDoes/);
  // And the probe composes no sentence: the reason an SDK that cannot load gets
  // is written on the server thread by `sdkInternalsProbeReason()`.
  assert.doesNotMatch(MCP_LISTING_WORKER_SOURCE, /second copy|is not the package Entity Assistant resolves|MCP support loads only from/);
  assert.equal(typeof MCP_LISTING_WORKER_SOURCE, "string");
});

test("the worker is a thread, and the wait for it is bounded", () => {
  // The property that matters cannot be seen in a reply: the module parsing has
  // to happen somewhere else. Pinned as source assertions rather than timings,
  // so this file cannot be flaky on a loaded box.
  assert.match(source, /new Worker\(/);
  assert.match(source, /\{ eval: true, workerData/);
  assert.match(source, /worker\.unref\(\)/);
  assert.ok(MCP_LISTING_WORKER_TIMEOUT_MS >= 10_000, "a cold SDK load is 1.7–4.9 s; the bound is a safety net, not a budget");
  // An eval worker carries no file for the packaged payload to miss
  // (DEFECT-000092: a worker whose file the payload lacks failed at runtime).
  assert.match(source, /new Worker\(source \?\? MCP_LISTING_WORKER_SOURCE, \{ eval: true/);
  // A timed-out worker is dropped, not reused: its module load is in an unknown state.
  assert.match(source, /stopMcpListingWorker\(state\);/);
});

// ---------------------------------------------------------------------------
// The SDK-internals probe (TASK-000277): Settings › MCP's `mcp.available`,
// answered in the same round trip as the listing's checks.
// ---------------------------------------------------------------------------

/** Echoes the probe answer a case wants, so the plumbing can be seen on its own. */
const PROBE_SOURCE = `
"use strict";
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ id, work }) => {
  parentPort.postMessage({
    id,
    ok: true,
    value: { validations: [], values: [], probe: work.probe && { ok: false, step: "member", module: "mcpServers", name: "validateMcpServerConfig", kind: "function" } },
  });
});
`;

const probe = { packageDir: "/sdk", sdkEntry: "/sdk/dist/index.js", modules: [], members: [] };

test("the probe comes back as facts, in the same round trip as the checks", async () => {
  const answer = await loadMcpListingAnswer({ entries: [], values: [], probe }, { source: PROBE_SOURCE, workerData: {} });
  assert.deepEqual(answer.probe, { ok: false, step: "member", module: "mcpServers", name: "validateMcpServerConfig", kind: "function" });
  // The sentence is written here, from the SDK's own file names.
  assert.equal(
    sdkInternalsProbeReason(answer.probe, probe),
    "dist/core/mcp-servers.js does not export validateMcpServerConfig as a function",
  );
});

test("a probe asked for and not answered is the worker's failure, never \"the SDK loads\"", async () => {
  await assert.rejects(loadMcpListingAnswer({ entries: [], values: [], probe }, { source: TABLE_SOURCE, workerData: {} }), (error) => {
    assert.equal(error.name, "McpListingError");
    assert.equal(error.code, "mcp-listing-worker-failed");
    assert.equal(error.retriable, true);
    assert.match(error.message, /without the SDK's internals/);
    return true;
  });
});

/** The probe's verdict, worded exactly as availability would report it. */
async function probeVerdictFor(data) {
  const answer = await loadMcpListingAnswer(
    { entries: [], values: [], probe: data },
    { source: MCP_LISTING_WORKER_SOURCE },
  );
  return answer.probe.ok ? { ok: true } : { ok: false, reason: sdkInternalsProbeReason(answer.probe, data) };
}

test("the probe agrees with importPiSdkInternals() about the SDK pi-web runs", async () => {
  const request = sdkInternalsProbeRequest({});
  assert.equal(request.ok, true, request.reason);
  assert.deepEqual(await probeVerdictFor(request.probe), { ok: true });
  // And the loader agrees, so the two halves describe one SDK.
  assert.equal((await importPiSdkInternals()).ok, true);
});

test("the probe gives the reasons importPiSdkInternals() gives for a broken install", async (t) => {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "pi-web-probe-parity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 1. No SDK to resolve: both answer on the server thread, with one sentence.
  const empty = join(root, "empty");
  await mkdir(empty);
  const located = sdkInternalsProbeRequest({}, empty);
  const loader = await importPiSdkInternals({ cwd: empty });
  assert.equal(located.ok, false);
  assert.equal(located.reason, loader.reason);
  assert.match(located.reason, /cannot locate @earendil-works\/pi-coding-agent/);

  // 2. A root that loads but says it lives elsewhere: the worker sees it, and
  //    the sentence is the loader's.
  const elsewhere = join(root, "elsewhere");
  const moved = join(root, "moved", "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(elsewhere);
  await mkdir(join(moved, "dist"), { recursive: true });
  await writeFile(join(moved, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    type: "module",
    exports: { ".": { import: "./dist/index.js" } },
  }));
  await writeFile(join(moved, "dist", "index.js"), [
    "export const createMcpExtension = () => ({});",
    `export const getPackageDir = () => ${JSON.stringify(elsewhere)};`,
    "",
  ].join("\n"));
  const movedRequest = sdkInternalsProbeRequest({}, join(root, "moved"));
  assert.equal(movedRequest.ok, true, movedRequest.reason);
  const movedVerdict = await probeVerdictFor(movedRequest.probe);
  const movedLoader = await importPiSdkInternals({ cwd: join(root, "moved") });
  assert.equal(movedLoader.ok, false);
  assert.equal(movedVerdict.reason, movedLoader.reason);
  assert.match(movedVerdict.reason, /is not the package Entity Assistant resolves/);

  // 3. A manifest whose root the package does not carry: the same "cannot load".
  const missing = join(root, "missing", "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(missing, { recursive: true });
  await writeFile(join(missing, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    type: "module",
    exports: { ".": { import: "./dist/index.js" } },
  }));
  const missingRequest = sdkInternalsProbeRequest({}, join(root, "missing"));
  assert.equal(missingRequest.ok, true, missingRequest.reason);
  const missingVerdict = await probeVerdictFor(missingRequest.probe);
  const missingLoader = await importPiSdkInternals({ cwd: join(root, "missing") });
  assert.equal(missingLoader.ok, false);
  // The sentence is this module's; the tail after ": " is Node's own text for an
  // import that failed, and it names the importer ("Require stack" on this
  // thread, "imported from ... [worker eval]" in the worker).
  const sentence = (reason) => reason.split(": ")[0];
  assert.equal(sentence(missingVerdict.reason), sentence(missingLoader.reason));
  assert.match(missingVerdict.reason, /cannot load .*dist.index\.js/);
});

// ---------------------------------------------------------------------------
// The built-in extension switches (TASK-000277): the settings read hands over
// the two `extensions` lists, the worker resolves them with the SDK's own
// package manager. `lib/builtin-extensions.test.mjs` holds the behavioural
// spec, run through this path.
// ---------------------------------------------------------------------------

/** Answers every message with an answer of its own shape: `{}` here, so a missing key shows. */
const EMPTY_SOURCE = `
"use strict";
require("node:worker_threads").parentPort.on("message", (message) => {
  require("node:worker_threads").parentPort.postMessage({ id: message.id, ok: true, value: {} });
});
`;

const SWITCH_SOURCE = `
"use strict";
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ id, kind, work }) => {
  const value = kind === "switches"
    ? { switches: work.sets.map((set) => ({ ...Object.fromEntries(work.builtins.map((name) => [name, { enabled: true }])), ...(set.project ? { mcp: { enabled: false, scope: "project" } } : {}) })) }
    : { validations: [], values: [] };
  parentPort.postMessage({ id, ok: true, value });
});
`;

const switchWork = {
  agentDir: "/agent",
  cwd: "/work",
  builtins: ["codemode", "tool-search", "mcp"],
  sets: [{ global: ["-builtin:mcp"] }, { project: ["+builtin:mcp"] }],
  modules: { packageManager: "/sdk/dist/core/package-manager.js", settingsManager: "/sdk/dist/core/settings-manager.js" },
};

test("the switches come back per resolution, as the settings read asked", async () => {
  const answers = await loadBuiltinSwitches(switchWork, { source: SWITCH_SOURCE, workerData: {} });
  assert.equal(answers.length, 2);
  assert.deepEqual(answers[0], { codemode: { enabled: true }, "tool-search": { enabled: true }, mcp: { enabled: true } });
  assert.deepEqual(answers[1].mcp, { enabled: false, scope: "project" });
});

test("switches asked for and not answered are a coded failure, never \"all on\"", async () => {
  await assert.rejects(loadBuiltinSwitches(switchWork, { source: EMPTY_SOURCE, workerData: {} }), (error) => {
    assert.equal(error.name, "McpListingError");
    assert.equal(error.code, "mcp-listing-worker-failed");
    assert.equal(error.retriable, true);
    assert.match(error.message, /answered without the built-in extension switches/);
    return true;
  });
  // A worker that throws is the same coded failure, with its own diagnostic.
  await assert.rejects(loadBuiltinSwitches(switchWork, { source: TABLE_SOURCE, workerData: {} }), (error) => {
    assert.equal(error.code, "mcp-listing-worker-failed");
    assert.equal(error.retriable, true);
    return true;
  });
  await assert.rejects(loadBuiltinSwitches(switchWork, { source: SILENT_SOURCE, workerData: {}, timeoutMs: 150 }), (error) => {
    assert.equal(error.code, "mcp-listing-timeout");
    assert.match(error.message, /reading the built-in extension switches did not finish within 150 ms/);
    return true;
  });
});

test("the settings read asks the worker, never the SDK, on the request thread", () => {
  // TASK-000277: `GET /api/mcp` was the last place that parsed the SDK graph on
  // the thread that answers requests — once through `loadPiSdkInternals()`, then
  // through the package manager inside `readBuiltinExtensionSwitches()`. Both
  // moved to the worker; the route also stopped importing the SDK root for
  // `getAgentDir()` (`lib/agent-dir.ts` answers that without it).
  const settingsRead = readFileSync(join(rootDir, "lib/mcp-config-read.ts"), "utf8");
  const builtinExtensions = readFileSync(join(rootDir, "lib/builtin-extensions.ts"), "utf8");
  const route = readFileSync(join(rootDir, "app/api/mcp/route.ts"), "utf8");
  assert.doesNotMatch(settingsRead, /loadPiSdkInternals\(\)\)|await loadPiSdkInternals\(/, "the listing asks the worker, not the SDK");
  assert.doesNotMatch(builtinExtensions, /await loadSdk\(\);/, "the switches resolve in the worker");
  assert.doesNotMatch(route, /getAgentDir/);
  assert.doesNotMatch(route, /^import \{[^}]*\} from "@earendil-works/m);
  // The GET's own failure is the listing's, named and retriable: the panel shows
  // the code and a retry instead of a diagnostic that looks like an empty file.
  assert.match(route, /const failure = mcpListingFailure\(error\);/);
  assert.match(route, /failure \? \{ code: failure\.code, retriable: failure\.retriable \} : \{\}/);
});

// ---------------------------------------------------------------------------
// Code mode merges (TASK-000277): a trusted project's settings merged with each
// global choice, as pi's own SettingsManager merges them. The behavioural spec
// is `lib/codemode-settings.test.mjs`, run through this path.
// ---------------------------------------------------------------------------

const MERGE_SOURCE = `
"use strict";
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ id, kind, work }) => {
  const value = kind === "codemode"
    ? { merges: work.cases.map((item) => ({ defaultTools: ["+codemode", "bash"], codemode: { mode: item.global ? "on" : "only" } })) }
    : { validations: [], values: [] };
  parentPort.postMessage({ id, ok: true, value });
});
`;

const mergeWork = { cases: [{ global: "{}", project: "{}" }, { project: "{}" }], modules: { settingsManager: "/sdk/dist/core/settings-manager.js" } };

test("a Code mode merge comes back as pi's own products, one per case", async () => {
  const merged = await loadCodemodeMerges(mergeWork, { source: MERGE_SOURCE, workerData: {} });
  assert.deepEqual(merged, [
    { defaultTools: ["+codemode", "bash"], codemode: { mode: "on" } },
    { defaultTools: ["+codemode", "bash"], codemode: { mode: "only" } },
  ]);
});

test("a merge asked for and not answered is a coded failure", async () => {
  await assert.rejects(loadCodemodeMerges(mergeWork, { source: EMPTY_SOURCE, workerData: {} }), (error) => {
    assert.equal(error.code, "mcp-listing-worker-failed");
    assert.equal(error.retriable, true);
    assert.match(error.message, /answered without the merged Code mode settings/);
    return true;
  });
});
