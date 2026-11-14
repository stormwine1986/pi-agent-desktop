import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { ProjectMcpListing, ProjectMcpListingErrorCode } from "./api-types";
import { mcpListingModuleFiles, type PiSdkInternals, type SdkInternalsProbe, type SdkInternalsProbeAnswer } from "./pi-sdk-internals";

/**
 * What `readProjectMcpServers()` needs from the pi SDK: the checks that decide
 * how an `mcp.json` entry is listed. Three pure functions of plain JSON.
 */
export type McpListingInternals = Pick<
  PiSdkInternals,
  "validateMcpServerConfig" | "isCommandConfigValue" | "getConfigValueEnvVarNames"
>;

/**
 * A built-in extension's switch, as the caller reads it: on, or off and which
 * scope's settings turned it off (the caller turns that into a file path).
 */
export interface BuiltinSwitchAnswer {
  enabled: boolean;
  scope?: "global" | "project";
}

/**
 * One resolution the switches read asks for: the `extensions` lists it would be
 * given, keyed by the scope they came from.
 */
export interface BuiltinSwitchSet {
  global?: string[];
  /** The trusted project's list; its presence is what makes the set trusted. */
  project?: string[];
}

/**
 * The built-in switches, resolved on the worker (TASK-000277):
 * `readBuiltinExtensionSwitches()` reads the two settings files on the server
 * thread (cheap, and under the same regular-file guards) and passes the lists
 * here; the worker constructs the SDK's own `DefaultPackageManager` over them —
 * the same class, from the same files — and reports each built-in's switch.
 * Nothing decides a path: the caller names the settings file.
 */
export interface BuiltinSwitchWork {
  agentDir: string;
  cwd: string;
  /** `BUILTIN_EXTENSION_NAMES`, in the caller's order. */
  builtins: string[];
  /** One entry per resolution; the second is the global-only answer. */
  sets: BuiltinSwitchSet[];
  /** Absolute file paths from `sdkSwitchModuleFiles()`. */
  modules: { packageManager: string; settingsManager: string };
}

/**
 * One merge `SettingsManager` makes for Code mode (TASK-000277, both products a
 * Settings › MCP read needs:
 * `projectCodemodePreference()` (`lib/codemode-settings.ts`) merges each global
 * choice with a trusted project's text and asks whether the result starts with
 * `codemode`. The merge is pi's, never a second implementation of its rules,
 * and it runs on the worker for the same reason the switches do: importing the
 * package root for `SettingsManager` was seconds on the request thread.
 */
/** One merge's two texts; `global` absent means the global scope declares nothing. */
export interface CodemodeMergeCase {
  global?: string;
  project: string;
}

export interface CodemodeMergeWork {
  /** The texts to merge, in the caller's order. */
  cases: CodemodeMergeCase[];
  /** Absolute file path from `sdkSwitchModuleFiles()`. */
  modules: { settingsManager: string };
}

/** What one merge gave: the tool list its sessions start with, and the merged `codemode` subtree. */
export interface CodemodeMergeAnswer {
  defaultTools?: string[];
  codemode?: unknown;
}

/** The checks are run on this data: the entries as parsed, and every value they resolve. */
export interface McpListingWork {
  entries: { name: string; value: unknown }[];
  /** The `env` / `headers` / `oauth.clientSecret` values of all the entries (`resolvedConfigValues()`). */
  values: string[];
  /**
   * Also report whether the SDK's MCP internals load (TASK-000277: Settings ›
   * MCP's `mcp.available`). Facts only — `sdkInternalsProbeReason()` words the
   * verdict on the server thread. Asked in the same round trip because the
   * worker has to load SDK files either way, and its module registry is the one
   * place where the probe's imports are free.
   */
  probe?: SdkInternalsProbe;
}

/** What the worker answered: the entry checks and every value's parse. */
export interface McpListingAnswer {
  /** The three checks, or `undefined` when the SDK cannot be located (entries are listed unchecked). */
  internals: McpListingInternals | undefined;
  /** The availability facts, when the request asked for them. */
  probe: SdkInternalsProbeAnswer | undefined;
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
  probe?: SdkInternalsProbeAnswer;
}

/** Which question a message asks; the worker answers one per message. */
type WorkerRequest =
  | { kind: "listing"; work: McpListingWork }
  | { kind: "switches"; work: BuiltinSwitchWork }
  | { kind: "codemode"; work: CodemodeMergeWork };

interface Pending {
  resolve: (value: unknown) => void;
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
function roundTrip<T>(
  state: McpListingWorker,
  request: WorkerRequest,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const id = state.nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new McpListingError("mcp-listing-timeout", `${what} did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
    state.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    try {
      state.worker.postMessage({ id, ...request });
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
 * The listing's answer, from the worker: the three checks and, when the
 * request asked for it, the SDK-internals facts Settings › MCP's availability
 * is decided from (TASK-000277).
 *
 * Resolves `internals: undefined` when the SDK cannot be located at all: the
 * listing then describes its entries unchecked, the answer it has always given
 * in that case. Rejects with `McpListingError` when the worker itself fails — a
 * crash, an exit, or no answer within `timeoutMs`.
 */
export async function loadMcpListingAnswer(
  work: McpListingWork,
  options: McpListingWorkerOptions = {},
): Promise<McpListingAnswer> {
  let workerData = options.workerData;
  if (workerData === undefined) {
    const files = mcpListingModuleFiles();
    if (!files.ok) return { internals: undefined, probe: undefined };
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
    const answer = await roundTrip<WorkerAnswer>(
      state,
      { kind: "listing", work },
      options.timeoutMs ?? MCP_LISTING_WORKER_TIMEOUT_MS,
      "listing the project's MCP servers",
    );
    // Asked for and not answered: treated as the worker's failure, never as "the
    // SDK loads" — the availability line must not be guessed.
    if (work.probe !== undefined && answer.probe === undefined) {
      throw new McpListingError("mcp-listing-worker-failed", "the MCP listing worker answered without the SDK's internals");
    }
    return { internals: checksFrom(work, answer), probe: answer.probe };
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
  return (await loadMcpListingAnswer(work, options)).internals;
}

/** One built-in's switch, per resolution, in `BuiltinSwitchWork.sets`' order. */
export type BuiltinSwitchResolution = Record<string, BuiltinSwitchAnswer>;

/**
 * A trusted project's Code mode, merged on the worker (TASK-000277): per case,
 * the `defaultTools` pi's own `SettingsManager` gives a project's sessions — or
 * `undefined` when the merge leaves none. The caller decides what the list
 * means (`projectCodemodePreference()`); no rule of pi's is reimplemented.
 *
 * Not cached: the texts come from the files of this request.
 */
export async function loadCodemodeMerges(
  work: CodemodeMergeWork,
  options: McpListingWorkerOptions = {},
): Promise<CodemodeMergeAnswer[]> {
  const state = startMcpListingWorker({ ...options, workerData: options.workerData ?? {} });
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  try {
    const answer = await roundTrip<{ merges?: CodemodeMergeAnswer[] }>(
      state,
      { kind: "codemode", work },
      options.timeoutMs ?? MCP_LISTING_WORKER_TIMEOUT_MS,
      "merging the project's settings for Code mode",
    );
    if (!Array.isArray(answer.merges) || answer.merges.length !== work.cases.length) {
      throw new McpListingError("mcp-listing-worker-failed", "the MCP listing worker answered without the merged Code mode settings");
    }
    return answer.merges;
  } catch (error) {
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

/**
 * The built-in extension switches, resolved on the worker (TASK-000277).
 *
 * `readBuiltinExtensionSwitches()` reads the two settings files and hands the
 * lists over; the worker constructs the SDK's own `DefaultPackageManager` over
 * them and reports each built-in's switch and the scope that turned it off. The
 * answer is not cached: a settings file can change while the worker lives, and
 * the panel must follow it. A worker that dies or times out rejects with
 * `McpListingError`, which the settings read treats as it always has (built-ins
 * on, `console.warn`), never as "MCP is off".
 */
export async function loadBuiltinSwitches(
  work: BuiltinSwitchWork,
  options: McpListingWorkerOptions = {},
): Promise<BuiltinSwitchResolution[]> {
  const state = startMcpListingWorker({ ...options, workerData: options.workerData ?? {} });
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = undefined;
  try {
    const answer = await roundTrip<{ switches?: BuiltinSwitchResolution[] }>(
      state,
      { kind: "switches", work },
      options.timeoutMs ?? MCP_LISTING_WORKER_TIMEOUT_MS,
      "reading the built-in extension switches",
    );
    if (!Array.isArray(answer.switches) || answer.switches.length !== work.sets.length) {
      throw new McpListingError("mcp-listing-worker-failed", "the MCP listing worker answered without the built-in extension switches");
    }
    return answer.switches;
  } catch (error) {
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
 * The third answer is the SDK-internals probe (TASK-000277): the request may
 * carry the files `importPiSdkInternals()` loads and the checks it makes on
 * them, and the worker reports what it saw — never a verdict, and never the
 * sentence that verdict gets (`sdkInternalsProbeReason()` words it on the
 * server thread). Settings › MCP asks for it in the same round trip, so the
 * dialog's own request no longer parses the SDK graph on the server's thread.
 *
 * Loaded by file URL rather than by bare specifier for the same reason
 * `lib/pi-sdk-internals.ts` does: the package exports `types`/`import` only, so
 * a CommonJS `require` is unresolved, and a bundled bare `import()` becomes
 * webpack's throwing placeholder on the server graph.
 */
export const MCP_LISTING_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { realpathSync } = require("node:fs");
const { pathToFileURL } = require("node:url");

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
  return { validations, values, probe: work.probe === undefined ? undefined : await probeInternals(work.probe) };
}

// ---- the SDK-internals probe (TASK-000277) ---------------------------------
// The same files and the same checks importPiSdkInternals() makes, in the same
// order, answered as facts. Nothing here composes a message: the reason a
// failure gets is written on the server thread, once, by
// sdkInternalsProbeReason(). importPiSdkInternals() (lib/pi-sdk-internals.ts)
// must keep matching this; lib/mcp-listing-worker.test.mjs runs both over the
// same SDK and compares the verdicts.

let probePromise = null;

function isClass(value) {
  return typeof value === "function" && /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

// Cached for the worker's life: the files cannot change under it, and a second
// look at Settings must not reload the SDK graph.
function probeInternals(probe) {
  if (!probePromise) probePromise = runProbe(probe);
  return probePromise;
}

async function runProbe(probe) {
  let root;
  try {
    root = await import(pathToFileURL(probe.sdkEntry).href);
  } catch (error) {
    return { ok: false, step: "entry-load", message: message(error) };
  }
  const createMcpExtension = root.createMcpExtension;
  const getPackageDir = root.getPackageDir;
  if (typeof createMcpExtension !== "function" || typeof getPackageDir !== "function") {
    return { ok: false, step: "entry-exports" };
  }
  let loadedDir;
  try {
    loadedDir = realpathSync(getPackageDir());
  } catch (error) {
    return { ok: false, step: "locate", message: message(error) };
  }
  if (!samePath(loadedDir, probe.packageDir)) return { ok: false, step: "package-dir", loadedDir };
  // pi-mcp was resolved (or not) on the server thread, in this same position:
  // importPiSdkInternals() resolves it before it imports any module.
  if (probe.mcpClientError !== undefined) return { ok: false, step: "mcp-client", message: probe.mcpClientError };
  const modules = {};
  for (const entry of probe.modules) {
    try {
      modules[entry.name] = await import(pathToFileURL(entry.path).href);
    } catch (error) {
      return { ok: false, step: "module-load", path: entry.path, message: message(error) };
    }
  }
  if (!modules.mcpExtension || modules.mcpExtension.createMcpExtension !== createMcpExtension) {
    return { ok: false, step: "second-copy" };
  }
  for (const member of probe.members) {
    const loaded = modules[member.module];
    const value = loaded ? loaded[member.name] : undefined;
    if (member.kind === "class" ? !isClass(value) : typeof value !== "function") {
      return { ok: false, step: "member", module: member.module, name: member.name, kind: member.kind };
    }
  }
  try {
    const transport = modules.mcpRuntime.createDefaultTransport(
      { name: "pi-web-probe", config: { command: "pi-web-probe" }, source: "pi-web" },
      probe.packageDir,
      undefined,
    );
    if (!(transport instanceof modules.mcpClient.StdioTransport)) return { ok: false, step: "transport-mismatch" };
  } catch (error) {
    return { ok: false, step: "transport-error", message: message(error) };
  }
  return { ok: true };
}

// ---- the built-in extension switches (TASK-000277) ------------------------
// The resolution readBuiltinExtensionSwitches() (lib/builtin-extensions.ts) makes,
// run on the SDK's own DefaultPackageManager from the two files it names. It
// reads only the lists it was handed (through the same withLock shape the
// settings manager takes) and reports which scope turned a built-in off; the
// caller names the settings file. Nothing is cached: a settings file can
// change while the worker lives.

let switchModulesPromise = null;

// Cached per file: the worker reuses one package manager for both the switches
// and the Code mode merges, and a SettingsManager file loads once per worker.
const settingsManagers = new Map();

function loadSettingsManager(path) {
  let loaded = settingsManagers.get(path);
  if (!loaded) {
    loaded = import(pathToFileURL(path).href).then((settingsManager) => {
      if (typeof settingsManager.SettingsManager?.fromStorage !== "function") {
        throw new Error(path + " does not export SettingsManager");
      }
      return settingsManager.SettingsManager;
    });
    settingsManagers.set(path, loaded);
  }
  return loaded;
}

function loadSwitchModules(modules) {
  if (!switchModulesPromise) {
    switchModulesPromise = Promise.all([
      import(pathToFileURL(modules.packageManager).href),
      loadSettingsManager(modules.settingsManager),
    ]).then(([packageManager, SettingsManager]) => {
      const DefaultPackageManager = packageManager.DefaultPackageManager;
      if (typeof DefaultPackageManager !== "function") {
        throw new Error(modules.packageManager + " does not export DefaultPackageManager");
      }
      return { DefaultPackageManager, SettingsManager };
    });
  }
  return switchModulesPromise;
}

// The merge Settings › MCP asks for: pi's own SettingsManager over the two
// texts, reduced to what its readers use — the defaultTools list sessions start
// with, and the merged codemode subtree.
async function codemodeMerges(work) {
  const SettingsManager = await loadSettingsManager(work.modules.settingsManager);
  const merges = [];
  for (const item of work.cases) {
    const texts = { global: item.global, project: item.project };
    const storage = { withLock: (scope, run) => run(texts[scope]) };
    const manager = SettingsManager.fromStorage(storage, { projectTrusted: true });
    const tools = manager.getDefaultTools();
    const settings = manager.getSettings();
    merges.push({
      defaultTools: Array.isArray(tools) ? tools : undefined,
      codemode: settings === null || typeof settings !== "object" ? undefined : settings.codemode,
    });
  }
  return { merges };
}

async function resolveSwitchSet(work, set, classes) {
  const storage = {
    withLock: (scope, run) => {
      const extensions = set[scope];
      return run(extensions ? JSON.stringify({ extensions }) : undefined);
    },
  };
  const packageManager = new classes.DefaultPackageManager({
    cwd: work.cwd,
    agentDir: work.agentDir,
    settingsManager: classes.SettingsManager.fromStorage(storage, { projectTrusted: set.project !== undefined }),
    builtinExtensions: work.builtins,
  });
  // Nothing is missing without packages; skip rather than install if that ever changes.
  const resolved = await packageManager.resolve(async () => "skip");
  const answer = {};
  for (const name of work.builtins) {
    const resource = resolved.extensions.find((extension) => extension.path === "builtin:" + name);
    const enabled = resource === undefined ? true : resource.enabled !== false;
    answer[name] = enabled ? { enabled } : { enabled, scope: resource.metadata?.scope === "project" ? "project" : "global" };
  }
  return answer;
}

async function switches(work) {
  const classes = await loadSwitchModules(work.modules);
  const answers = [];
  for (const set of work.sets) answers.push(await resolveSwitchSet(work, set, classes));
  return { switches: answers };
}

parentPort.on("message", (message) => {
  if (!message || typeof message.id !== "number") return;
  const id = message.id;
  const run = message.kind === "switches"
    ? switches(message.work)
    : message.kind === "codemode" ? codemodeMerges(message.work) : answer(message.work);
  run
    .then((value) => parentPort.postMessage({ id, ok: true, value }))
    .catch((error) => parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
});
`;
