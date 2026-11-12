import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./agent-dir.ts";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import type { ModelScopeWarning } from "./model-scope-warnings";

export interface ModelsData {
  models: Record<string, string>;
  modelList: { id: string; name: string; provider: string; input?: string[] }[];
  defaultModel: { provider: string; modelId: string } | null;
  /** Resolved thinking level a new session starts with when the user has not picked one. */
  defaultThinkingLevel: string | null;
  /** `defaultThinkingLevel` as saved in settings, which the reasoning selector's star marks. */
  savedDefaultThinkingLevel: string | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider/modelId` → thinking level pinned by an `enabledModels` `:level` suffix. */
  thinkingLevelPins: Record<string, string>;
  modelError?: string;
  /** Warnings from resolving the `enabledModels` scope (e.g. a pattern matched nothing). */
  modelScopeWarnings?: ModelScopeWarning[];
}

interface ModelsCacheState {
  entries: Map<string, { data: ModelsData; expiresAt: number }>;
  inFlight: Map<string, Promise<ModelsData>>;
  generation: number;
}

declare global {
  var __piModelsCacheState: ModelsCacheState | undefined;
}

const MODELS_CACHE_TTL_MS = 60_000;
/** Last good lists, so a cold start can answer before anything is loaded. */
const MODELS_SNAPSHOT_VERSION = 1;
const MODELS_SNAPSHOT_MAX_ENTRIES = 16;
const MAX_MODELS_CACHE_ENTRIES = 32;
/** Lets the requests of a session switch finish before a background refresh blocks the loop. */
const STALE_REFRESH_DELAY_MS = 1_500;
// Never interpolate the caught error here; SDK errors can contain paths and provider details.
const SAFE_MODEL_LOAD_FAILURE_MESSAGE = "Model list is temporarily unavailable. Check your configuration and try again.";

function getModelsCacheState(): ModelsCacheState {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: new Map(),
      inFlight: new Map(),
      generation: 0,
    };
  }
  return globalThis.__piModelsCacheState;
}

export function invalidateModelsCache(): void {
  const state = getModelsCacheState();
  state.generation += 1;
  state.entries.clear();
  state.inFlight.clear();
}

export function withModelRuntimeError(data: ModelsData, modelError: string | undefined): ModelsData {
  return modelError ? { ...data, modelError } : data;
}

export function withSafeModelLoadFailure(data: ModelsData): ModelsData {
  return { ...data, modelError: SAFE_MODEL_LOAD_FAILURE_MESSAGE };
}

/**
 * Answer **without waiting for a load** (DEFECT-000101).
 *
 * `GET /api/models` lands a few seconds after the window appears, and building
 * the list costs the pi SDK's 2.6–2.9 s module load. So this never awaits:
 *
 * - a fresh entry is returned as is;
 * - a stale entry is returned now and refreshed in the background (as before);
 * - with no entry at all, the last good list from the previous run is returned
 *   and a warm starts; on a machine that never had one, `data` is undefined and
 *   the caller answers a placeholder while the warm runs.
 *
 * `pending` says a load is in flight, which is what the panel uses to fetch the
 * finished list instead of showing an empty selector forever.
 */
export interface ModelsCachePeek {
  data?: ModelsData;
  pending: boolean;
}

export function peekModelsCache(cwd: string, loader: () => Promise<ModelsData>): ModelsCachePeek {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt <= Date.now() && !state.inFlight.has(cwd)) {
      scheduleRefresh(state, cwd, loader, cached);
    }
    return { data: cached.data, pending: state.inFlight.has(cwd) };
  }

  const persisted = readPersistedModels(cwd);
  const inFlight = state.inFlight.has(cwd);
  if (!inFlight) {
    startLoad(state, cwd, loader).catch((error) => {
      // The placeholder already answered; say why the list never arrived.
      console.error("[models] warming the model catalogue failed:", error instanceof Error ? error.message : error);
    });
  }
  if (persisted) {
    // Serve last run's list for this cwd; the warm replaces it moments later.
    state.entries.set(cwd, { data: persisted, expiresAt: 0 });
    return { data: persisted, pending: true };
  }
  return { pending: true };
}

function scheduleRefresh(
  state: ModelsCacheState,
  cwd: string,
  loader: () => Promise<ModelsData>,
  cached: { data: ModelsData; expiresAt: number },
): void {
  const generation = state.generation;
  const timer = setTimeout(() => {
    if (state.generation !== generation || state.inFlight.has(cwd)) return;
    // A failed refresh keeps serving the old list; the next request tries again.
    startLoad(state, cwd, loader).catch(() => { cached.expiresAt = 0; });
  }, STALE_REFRESH_DELAY_MS);
  timer.unref?.();
  // Mark the refresh as scheduled so concurrent stale hits start only one.
  cached.expiresAt = Number.POSITIVE_INFINITY;
}

/**
 * Model lists keyed by cwd. A fresh entry is returned as is. An expired one is still
 * returned at once, and a refresh starts a moment later in the background: building the
 * SDK services blocks the event loop (extension imports, skill scans), and running that
 * inside a session switch held up the session's own read by up to a second. Explicit
 * config changes call `invalidateModelsCache()`, so the TTL only catches edits made
 * outside the app, which the next request after the refresh then sees.
 */
export function loadModelsWithCache(cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const state = getModelsCacheState();
  const cached = state.entries.get(cwd);
  if (cached) {
    if (cached.expiresAt <= Date.now() && !state.inFlight.has(cwd)) {
      scheduleRefresh(state, cwd, loader, cached);
    }
    return Promise.resolve(cached.data);
  }

  return state.inFlight.get(cwd) ?? startLoad(state, cwd, loader);
}

function startLoad(state: ModelsCacheState, cwd: string, loader: () => Promise<ModelsData>): Promise<ModelsData> {
  const generation = state.generation;
  const loadPromise: Promise<ModelsData> = Promise.resolve()
    .then(loader)
    .then((data) => {
      if (state.generation === generation && state.inFlight.get(cwd) === loadPromise) {
        state.entries.delete(cwd);
        while (state.entries.size >= MAX_MODELS_CACHE_ENTRIES) {
          const oldestKey = state.entries.keys().next().value;
          if (oldestKey === undefined) break;
          state.entries.delete(oldestKey);
        }
        state.entries.set(cwd, { data, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
        persistModels(cwd, data);
      }
      return data;
    })
    .finally(() => {
      if (state.inFlight.get(cwd) === loadPromise) state.inFlight.delete(cwd);
    });

  state.inFlight.set(cwd, loadPromise);
  return loadPromise;
}

// ---------------------------------------------------------------------------
// Last good list on disk: the difference between "empty selector on a cold
// start" and "the list you saw last time, replaced by a fresh one in a moment".
// A model list is names, ids and thinking levels — no credentials.
// ---------------------------------------------------------------------------

interface ModelsSnapshotFile {
  version: number;
  entries: Record<string, ModelsData>;
}

function snapshotPath(): string {
  return join(agentDir(), "pi-web-models-cache.json");
}

declare global {
  var __piModelsSnapshot: ModelsSnapshotFile | undefined;
}

function snapshot(): ModelsSnapshotFile {
  if (globalThis.__piModelsSnapshot) return globalThis.__piModelsSnapshot;
  let parsed: ModelsSnapshotFile | undefined;
  try {
    if (existsSync(snapshotPath())) {
      const value: unknown = JSON.parse(readFileSync(snapshotPath(), "utf8"));
      if (value && typeof value === "object" && (value as ModelsSnapshotFile).version === MODELS_SNAPSHOT_VERSION) {
        const entries = (value as ModelsSnapshotFile).entries;
        if (entries && typeof entries === "object" && !Array.isArray(entries)) parsed = value as ModelsSnapshotFile;
      }
    }
  } catch {
    // A corrupt or unreadable snapshot only costs one warm load.
  }
  globalThis.__piModelsSnapshot = parsed ?? { version: MODELS_SNAPSHOT_VERSION, entries: {} };
  return globalThis.__piModelsSnapshot;
}

function readPersistedModels(cwd: string): ModelsData | undefined {
  const data = snapshot().entries[cwd];
  return data && Array.isArray(data.modelList) && data.models ? data : undefined;
}

function persistModels(cwd: string, data: ModelsData): void {
  try {
    const file = snapshot();
    file.entries[cwd] = data;
    const keys = Object.keys(file.entries);
    while (keys.length > MODELS_SNAPSHOT_MAX_ENTRIES) {
      const oldest = keys.shift();
      if (oldest === undefined) break;
      delete file.entries[oldest];
    }
    writePrivateFileAtomicSync(snapshotPath(), JSON.stringify(file));
  } catch {
    // Persistence is best-effort; the in-memory entry remains authoritative.
  }
}
