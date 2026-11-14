import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { ProjectMcpListing, ProjectMcpListingErrorCode } from "./api-types";
import { mcpListingModuleFiles, type PiSdkInternals } from "./pi-sdk-internals";

/**
 * What `readProjectMcpServers()` needs from the pi SDK: the checks that decide
 * how an `mcp.json` entry is listed. Three pure functions of plain JSON.
 */
export type McpListingInternals = Pick<
  PiSdkInternals,
  "validateMcpServerConfig" | "isCommandConfigValue" | "getConfigValueEnvVarNames"
>;

/** The checks are run on this data: the entries as parsed, and every value they resolve. */
export interface McpListingWork {
  entries: { name: string; value: unknown }[];
  /** The `env` / `headers` / `oauth.clientSecret` values of all the entries (`resolvedConfigValues()`). */
  values: string[];
}

/**
 * The project's MCP listing, built on a worker thread.
 *
 * `readProjectMcpServers()` describes every entry of `.pi/mcp.json` with the
 * SDK's own validator and value parsers. Loading them is the whole cost: the
 * process's first `import()` of the SDK package root and its MCP modules blocks
 * the server's loop for 1.7–4.9 s in the packaged Node, measured on the trust
 * request itself (TASK-000213 logged 3016 / 3910 / 4871 ms and moved the
 * first-screen half to `?servers=0`). On this thread that is a dialog that
 * looks frozen. In a worker the same parse costs the same CPU and blocks
 * nothing, so the dialog shows its "Reading .pi/mcp.json…" state and fills in
 * when the answer arrives.
 *
 * Only data crosses the boundary: entries in, `validateMcpServerConfig()`'s
 * verdicts and the two value parsers' answers out. Every decision — masking,
 * what replaces what, which entry the loader refuses — stays on the server
 * thread in `lib/mcp-config-read.ts`, exactly where it already was.
 *
 * The worker is kept alive for `IDLE_MS` after the last request (the module
 * load is the expensive part; a second look at the dialog must not pay it
 * again) and `unref()`ed so it can never keep the server alive.
 *
 * A crash or a timeout rejects with `McpListingError`, carrying a `code` and
 * `retriable` for the dialog: never an empty list pretending the file declares
 * no servers. An SDK that cannot be found is *not* an error — this listing has
 * always fallen back to unchecked entries there (`loadPiSdkInternals()` with
 * `ok: false`), and that answer is kept unchanged.
 */

const IDLE_MS = 5 * 60_000;

/** How long one request waits for the worker before it is reported as timed out and dropped. */
export const MCP_LISTING_WORKER_TIMEOUT_MS = 30_000;

/** The failure this module reports: a readable code, and whether asking again can work. */
export class McpListingError extends Error {
  readonly code: ProjectMcpListingErrorCode;

  /** Every failure here is worth retrying: a fresh worker either loads or fails the same way. */
  readonly retriable = true;

  constructor(code: ProjectMcpListingErrorCode, message: string) {
    super(message);
    this.name = "McpListingError";
    this.code = code;
  }
}

/**
 * The code and retry verdict of a listing failure, for a caller that catches
 * one; `undefined` for every other error (a reader that threw, a missing
 * project file), which keeps its old answer without a code.
 */
export function mcpListingFailure(error: unknown): { code: ProjectMcpListingErrorCode; retriable: boolean } | undefined {
  if (error instanceof McpListingError) return { code: error.code, retriable: error.retriable };
  // Not `instanceof` alone: a bundler can give the route and the reader two
  // copies of this class, and the failure would then lose its code.
  const candidate = error as { name?: unknown; code?: unknown; retriable?: unknown } | null | undefined;
  if (candidate?.name === "McpListingError" && (candidate.code === "mcp-listing-timeout" || candidate.code === "mcp-listing-worker-failed")) {
    return { code: candidate.code, retriable: candidate.retriable === true };
  }
  return undefined;
}

/**
 * The listing answer for a build that failed: the diagnostic, plus the code and
 * retry verdict the dialog needs. `undefined` for a failure that is not the
 * build's own (the route then answers as it always did, with `mcpError` alone).
 *
 * Never an empty list *instead of* an error: `mcpError` is what tells the
 * dialog this is a failure, and `mcpFile` stays absent, so nothing can read
 * `mcpServers: []` as "this file declares no servers".
 */
export function mcpListingFailureBody(error: unknown): ProjectMcpListing | undefined {
  const failure = mcpListingFailure(error);
  if (!failure) return undefined;
  return {
    mcpServers: [],
    mcpError: errorMessage(error),
    mcpErrorCode: failure.code,
    mcpRetriable: failure.retriable,
  };
}

/** One entry's verdict, as the worker posts it. */
type WorkerValidation =
  | { kind: "error"; message: string }
  | { kind: "config"; config: McpServerConfig }
  | { kind: "none" };

interface WorkerAnswer {
  validations: WorkerValidation[];
  /** `[text, isCommandConfigValue(text), getConfigValueEnvVarNames(text)]`, in the request's order. */
  values: [text: string, isCommand: boolean, names: string[]][];
}

interface Pending {
  resolve: (value: WorkerAnswer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpListingWorker {
  worker: Worker;
  pending: Map<number, Pending>;
  nextId: number;
  idleTimer: NodeJS.Timeout | undefined;
}

declare global {
  var __piMcpListingWorker: McpListingWorker | undefined;
}

export interface McpListingWorkerOptions {
  /** Test seam: the work the worker runs. Defaults to the listing source. */
  source?: string;
  /** Test seam: the worker `workerData`, in place of the SDK module URLs. */
  workerData?: Record<string, unknown>;
  /** Test seam: how long one request waits. */
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Start (or reuse) the listing worker. Exported for the test seam. */
export function startMcpListingWorker(options: McpListingWorkerOptions = {}): McpListingWorker {
  const source = options.source;
  if (source === undefined) {
    const existing = globalThis.__piMcpListingWorker;
    if (existing) return existing;
  }

  const worker = new Worker(source ?? MCP_LISTING_WORKER_SOURCE, { eval: true, workerData: options.workerData ?? {} });
  // Never keep the process alive for a listing.
  worker.unref();
  const state: McpListingWorker = { worker, pending: new Map(), nextId: 0, idleTimer: undefined };

  const fail = (error: Error) => {
    for (const [, pending] of state.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    state.pending.clear();
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = undefined;
    if (globalThis.__piMcpListingWorker === state) globalThis.__piMcpListingWorker = undefined;
  };

  worker.on("message", (message: { id?: unknown; ok?: unknown; value?: unknown; error?: unknown }) => {
    if (!message || typeof message.id !== "number") return;
    const pending = state.pending.get(message.id);
    if (!pending) return;
    state.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.value as WorkerAnswer);
    else pending.reject(new McpListingError("mcp-listing-worker-failed", typeof message.error === "string" ? message.error : "the MCP listing worker failed"));
  });
  worker.on("error", (error) => fail(new McpListingError("mcp-listing-worker-failed", `the MCP listing worker failed: ${errorMessage(error)}`)));
  worker.on("exit", () => fail(new McpListingError("mcp-listing-worker-failed", "the MCP listing worker exited")));

  if (source === undefined) globalThis.__piMcpListingWorker = state;
  return state;
}

/** One request/response round trip, bounded: a worker that never answers must not hold the dialog. */
function roundTrip(state: McpListingWorker, work: McpListingWork, timeoutMs: number): Promise<WorkerAnswer> {
  const id = state.nextId++;
  return new Promise<WorkerAnswer>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new McpListingError("mcp-listing-timeout", `listing the project's MCP servers did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    state.pending.set(id, { resolve, reject, timer });
    try {
      state.worker.postMessage({ id, work });
    } catch (error) {
      state.pending.delete(id);
      clearTimeout(timer);
      reject(new McpListingError("mcp-listing-worker-failed", `the MCP listing worker could not be asked: ${errorMessage(error)}`));
    }
  });
}

/** The request's entries, keyed so a verdict can be found from the entry it belongs to. */
function entryKey(name: string, value: unknown): string {
  return `${name}\u0000${JSON.stringify(value)}`;
}

/**
 * The three checks, answered from the worker's reply. A miss is a failure of
 * this module, not a lenient answer: the request carries every entry and every
 * value the description walks, so a lookup that has nothing is a bug, and
 * guessing there would list an entry differently from how the SDK reads it.
 */
function checksFrom(work: McpListingWork, answer: WorkerAnswer): McpListingInternals {
  const validations = new Map<string, McpServerConfig | string | undefined>();
  work.entries.forEach((entry, index) => {
    const validation = answer.validations[index];
    validations.set(
      entryKey(entry.name, entry.value),
      validation?.kind === "error" ? validation.message : validation?.kind === "config" ? validation.config : undefined,
    );
  });
  const values = new Map(answer.values.map(([text, isCommand, names]) => [text, { isCommand, names }] as const));
  const answered = (what: string) => new McpListingError("mcp-listing-worker-failed", `the MCP listing worker answered without ${what}`);
  return {
    validateMcpServerConfig(name, value) {
      const key = entryKey(name, value);
      if (!validations.has(key)) throw answered(`the verdict for the server "${name}"`);
      // The SDK's declaration has no "no verdict"; the reader guards for one
      // anyway, so an undefined answer (a validator that returned nothing) is
      // passed through as it is rather than made up.
      return validations.get(key) as McpServerConfig | string;
    },
    isCommandConfigValue(text) {
      const parsed = values.get(text);
      if (!parsed) throw answered("a value's parse");
      return parsed.isCommand;
    },
    getConfigValueEnvVarNames(text) {
      const parsed = values.get(text);
      if (!parsed) throw answered("a value's parse");
      return parsed.names;
    },
  };
}

/**
 * The listing's checks, from the worker.
 *
 * Resolves `undefined` when the SDK cannot be located at all: the listing then
 * describes its entries unchecked, the answer it has always given in that case.
 * Rejects with `McpListingError` when the worker itself fails — a crash, an
 * exit, or no answer within `timeoutMs`.
 */
export async function loadMcpListingInternals(
  work: McpListingWork,
  options: McpListingWorkerOptions = {},
): Promise<McpListingInternals | undefined> {
  let workerData = options.workerData;
  if (workerData === undefined) {
    const files = mcpListingModuleFiles();
    if (!files.ok) return undefined;
    workerData = {
      serversUrl: pathToFileURL(files.servers).href,
      configValuesUrl: pathToFileURL(files.configValues).href,
      modules: `${files.servers} and ${files.configValues}`,
    };
  }

  const state = startMcpListingWorker({ ...options, workerData });
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  try {
    return checksFrom(work, await roundTrip(state, work, options.timeoutMs ?? MCP_LISTING_WORKER_TIMEOUT_MS));
  } catch (error) {
    // A worker that timed out or threw is not reused: its module load is in an
    // unknown state, and a retry should start from a clean one.
    stopMcpListingWorker(state);
    throw error;
  } finally {
    if (options.source === undefined && globalThis.__piMcpListingWorker === state) {
      state.idleTimer = setTimeout(() => {
        globalThis.__piMcpListingWorker = undefined;
        state.worker.terminate().catch(() => undefined);
      }, IDLE_MS);
      state.idleTimer.unref?.();
    }
  }
}

/** Test/shutdown hook: drop the worker without waiting for the idle timer. */
export function stopMcpListingWorker(target?: McpListingWorker): void {
  const state = target ?? globalThis.__piMcpListingWorker;
  if (!state) return;
  if (globalThis.__piMcpListingWorker === state) globalThis.__piMcpListingWorker = undefined;
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  for (const [, pending] of state.pending) {
    clearTimeout(pending.timer);
    pending.reject(new McpListingError("mcp-listing-worker-failed", "the MCP listing worker was stopped"));
  }
  state.pending.clear();
  state.worker.terminate().catch(() => undefined);
}

/**
 * The body of the listing worker.
 *
 * It is a string because a worker that needs a *file* would have to be traced
 * into the Next standalone payload, and `outputFileTracingExcludes` is inert on
 * Windows (see `docs/agents/fork-desktop.md`): a `new Worker(path)` whose file
 * the payload does not carry fails at runtime with a defect-shaped error —
 * exactly how DEFECT-000092 disabled MCP for a whole release. An `eval` worker
 * carries no file, so the payload needs nothing new.
 *
 * The code is deliberately thin: import the SDK's two files, answer the three
 * checks for the data it was given, post plain JSON back. It reads nothing, and
 * decides nothing (`lib/mcp-listing-worker.test.mjs` pins that).
 *
 * Loaded by file URL rather than by bare specifier for the same reason
 * `lib/pi-sdk-internals.ts` does: the package exports `types`/`import` only, so
 * a CommonJS `require` is unresolved, and a bundled bare `import()` becomes
 * webpack's throwing placeholder on the server graph.
 */
export const MCP_LISTING_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

let checksPromise = null;

function loadChecks() {
  if (!checksPromise) {
    checksPromise = (async () => {
      const servers = await import(workerData.serversUrl);
      const configValues = await import(workerData.configValuesUrl);
      const validate = servers.validateMcpServerConfig;
      const isCommand = configValues.isCommandConfigValue;
      const envVarNames = configValues.getConfigValueEnvVarNames;
      if (typeof validate !== "function" || typeof isCommand !== "function" || typeof envVarNames !== "function") {
        throw new Error(workerData.modules + " do not export the MCP checks");
      }
      return { validate, isCommand, envVarNames };
    })();
  }
  return checksPromise;
}

// The validator's object goes back as it is unless structured clone refuses it.
function plain(value) {
  try {
    structuredClone(value);
    return value;
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

async function answer(work) {
  const checks = await loadChecks();
  const values = work.values.map((text) => [text, checks.isCommand(text), checks.envVarNames(text)]);
  const validations = work.entries.map((entry) => {
    const validation = checks.validate(entry.name, entry.value);
    if (typeof validation === "string") return { kind: "error", message: validation };
    if (validation === undefined || validation === null) return { kind: "none" };
    return { kind: "config", config: plain(validation) };
  });
  return { validations, values };
}

parentPort.on("message", (message) => {
  if (!message || typeof message.id !== "number") return;
  const id = message.id;
  answer(message.work)
    .then((value) => parentPort.postMessage({ id, ok: true, value }))
    .catch((error) => parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
});
`;
