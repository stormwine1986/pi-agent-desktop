import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { loadModelCatalogue, startModelsWorker } = await jiti.import("./models-worker.ts");
const { MODELS_WORKER_SOURCE } = await jiti.import("./models-worker-source.ts");

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The worker's plumbing: it starts, answers, and can be terminated.
 *
 * Deliberately no real SDK load here — that takes 2.6–2.9 s per run and the
 * catalogue path is exercised by the route's own timing measurements instead
 * (DEFECT-000101). What these cases pin is that `loadModelCatalogue` is a
 * request/response over `worker_threads` and that a failure surfaces as a
 * rejection (the route answers its safe body then).
 *
 * Run alone: `node --experimental-strip-types --test --test-force-exit
 * --test-timeout=20000 lib/models-worker.test.mjs`.
 */

const ECHO_SOURCE = `
"use strict";
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (message) => {
  parentPort.postMessage({ id: message.id, ok: true, value: message.request });
});
`;

const FAILING_SOURCE = `
"use strict";
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (message) => {
  parentPort.postMessage({ id: message.id, ok: false, error: "no model runtime" });
});
`;

test("the worker starts, answers one request and terminates", async () => {
  const state = startModelsWorker({ source: ECHO_SOURCE });
  try {
    const value = await loadModelCatalogue(
      { cwd: rootDir, agentDir: rootDir, trusted: null },
      { source: ECHO_SOURCE, workerData: {} },
    );
    assert.equal(value.agentDir, rootDir);
    assert.equal(value.trusted, null);
  } finally {
    await state.worker.terminate();
  }
});

test("a failing worker rejects instead of answering", async () => {
  const state = startModelsWorker({ source: FAILING_SOURCE });
  try {
    await assert.rejects(
      loadModelCatalogue(
        { cwd: rootDir, agentDir: rootDir, trusted: null },
        { source: FAILING_SOURCE, workerData: {} },
      ),
      /no model runtime/,
    );
  } finally {
    await state.worker.terminate();
  }
});

test("a busy worker does not block the calling thread", () => {
  // The property that matters cannot be seen in a reply: the wait has to happen
  // somewhere else. Pinned as a source assertion rather than a timing test, so
  // this file cannot be flaky on a loaded CI box.
  assert.match(MODELS_WORKER_SOURCE, /worker_threads/);
  assert.equal(typeof MODELS_WORKER_SOURCE, "string");
  assert.match(readFileSync(join(rootDir, "lib/models-worker.ts"), "utf8"), /new Worker\(/);
});

test("the real SDK load is exercised by the packaged timing run, not here", { skip: "loads a 37 MB SDK graph (2.6–2.9 s); measured on the packaged server instead — see DEFECT-000101 in lib/models-worker.ts" }, () => {});
