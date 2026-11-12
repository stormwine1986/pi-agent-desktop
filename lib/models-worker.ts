import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { resolvePackageImportEntry } from "./package-entry";
import type { ModelCatalogueRequest, ModelCatalogueSnapshot } from "./models-catalogue";
import { MODELS_WORKER_SOURCE } from "./models-worker-source";

/**
 * The model catalogue, built on a worker thread.
 *
 * Why a worker and not a bigger cache: building it loads
 * `@earendil-works/pi-coding-agent`, a 37 MB ESM graph that takes 2.6–2.9 s of
 * **synchronous** module loading inside the packaged Node. On the server's own
 * thread that is a frozen app: `GET /api/models` is the first request after the
 * window appears, so the freeze landed while the user was already typing
 * (DEFECT-000101 — six cold starts out of six, `event loop blocked for
 * 2751–2999 ms`). Loading the same graph in a worker costs the same CPU and
 * blocks nothing.
 *
 * One worker is kept alive and reused: the module load is the expensive part,
 * and a fresh worker per request would pay it again. It is `unref()`ed so it can
 * never keep the server alive, and dropped after `IDLE_MS` without a request so
 * a user who is not touching the model selector is not charged its memory.
 *
 * What crosses the boundary is JSON only (`ModelCatalogueSnapshot`). The SDK
 * never enters this thread's module graph — `lib/first-screen-graph.test.mjs`
 * fails if `@earendil-works/` appears in this file or in its callers.
 */

const IDLE_MS = 5 * 60_000;

interface Pending {
  resolve: (value: ModelCatalogueSnapshot) => void;
  reject: (error: Error) => void;
}

interface ModelsWorker {
  worker: Worker;
  pending: Map<number, Pending>;
  nextId: number;
  idleTimer: NodeJS.Timeout | undefined;
}

declare global {
  var __piModelsWorker: ModelsWorker | undefined;
}

export interface ModelsWorkerOptions {
  /** Test seam: the work the worker runs. Defaults to the model-catalogue source. */
  source?: string;
  /** Test seam: the worker `workerData`. */
  workerData?: Record<string, unknown>;
}

function sdkEntryUrls(): { sdkEntry: string; aiEntry: string } {
  // Resolved once per process from the running server's own node_modules: the
  // packaged server runs with its payload as cwd, `next dev` with the project.
  const entries = {
    sdkEntry: pathToFileURL(resolvePackageImportEntry("@earendil-works/pi-coding-agent")).href,
    aiEntry: pathToFileURL(resolvePackageImportEntry("@earendil-works/pi-ai")).href,
  };
  return entries;
}

/** Start (or reuse) the catalogue worker. Exported for the test seam. */
export function startModelsWorker(options: ModelsWorkerOptions = {}): ModelsWorker {
  const source = options.source;
  if (source === undefined) {
    const existing = globalThis.__piModelsWorker;
    if (existing) return existing;
  }

  let workerData: Record<string, unknown> = options.workerData ?? {};
  if (source === undefined) {
    try {
      workerData = sdkEntryUrls();
    } catch (error) {
      // The bare specifiers in the worker source are the fallback: an eval
      // worker resolves them from the server's cwd.
      console.error("[models] could not resolve the pi SDK entry:", error instanceof Error ? error.message : error);
    }
  }

  const worker = new Worker(source ?? MODELS_WORKER_SOURCE, { eval: true, workerData });
  // Never keep the process alive for the catalogue.
  worker.unref();
  const state: ModelsWorker = { worker, pending: new Map(), nextId: 0, idleTimer: undefined };

  const fail = (error: Error) => {
    for (const [, pending] of state.pending) pending.reject(error);
    state.pending.clear();
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    if (globalThis.__piModelsWorker === state) globalThis.__piModelsWorker = undefined;
  };

  worker.on("message", (message: { id?: unknown; ok?: unknown; value?: unknown; error?: unknown }) => {
    if (!message || typeof message.id !== "number") return;
    const pending = state.pending.get(message.id);
    if (!pending) return;
    state.pending.delete(message.id);
    if (message.ok) pending.resolve(message.value as ModelCatalogueSnapshot);
    else pending.reject(new Error(typeof message.error === "string" ? message.error : "model catalogue failed"));
  });
  worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  worker.on("exit", () => fail(new Error("the model catalogue worker exited")));

  if (source === undefined) globalThis.__piModelsWorker = state;
  return state;
}

/** One request/response round trip on a given worker. */
function roundTrip(
  state: ModelsWorker,
  payload: unknown,
): Promise<ModelCatalogueSnapshot> {
  const id = state.nextId++;
  return new Promise<ModelCatalogueSnapshot>((resolve, reject) => {
    state.pending.set(id, { resolve, reject });
    state.worker.postMessage({ id, request: payload });
  });
}

/**
 * Read the model catalogue from the worker.
 *
 * Rejects when the worker cannot be started or dies mid-request; the route then
 * answers the same safe "model list temporarily unavailable" body it already
 * used for a failed load. There is deliberately no in-process fallback: a
 * fallback would put the 2.7 s back on the event loop, which is the defect.
 */
export async function loadModelCatalogue(
  requestPayload: ModelCatalogueRequest,
  options: ModelsWorkerOptions = {},
): Promise<ModelCatalogueSnapshot> {
  const state = startModelsWorker(options);
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  try {
    return await roundTrip(state, requestPayload);
  } finally {
    if (options.source === undefined && globalThis.__piModelsWorker === state) {
      state.idleTimer = setTimeout(() => {
        globalThis.__piModelsWorker = undefined;
        state.worker.terminate().catch(() => undefined);
      }, IDLE_MS);
      state.idleTimer.unref?.();
    }
  }
}

/** Test/shutdown hook: drop the worker without waiting for the idle timer. */
export function stopModelsWorker(): void {
  const state = globalThis.__piModelsWorker;
  globalThis.__piModelsWorker = undefined;
  if (!state) return;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  for (const [, pending] of state.pending) pending.reject(new Error("model catalogue worker stopped"));
  state.pending.clear();
  state.worker.terminate().catch(() => undefined);
}
