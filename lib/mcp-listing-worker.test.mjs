import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  MCP_LISTING_WORKER_TIMEOUT_MS,
  McpListingError,
  loadMcpListingInternals,
  mcpListingFailure,
  mcpListingFailureBody,
  MCP_LISTING_WORKER_SOURCE,
} = await jiti.import("./mcp-listing-worker.ts");

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
  assert.doesNotMatch(MCP_LISTING_WORKER_SOURCE, /node:fs|node:child_process|readFile|readdir|writeFile/);
  // It answers the three checks and nothing else: no masking, no ordering, no
  // "which entry replaces which" — those stay in lib/mcp-config-read.ts.
  assert.doesNotMatch(MCP_LISTING_WORKER_SOURCE, /maskCommand|maskUrl|maskArgs|shadowedByProject|replacesGlobal|refuseAsLoaderDoes/);
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
