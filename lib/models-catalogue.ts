import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isChatFolderPath, isChatWorkspacePath } from "./chat-workspace";
import { readChatSettings, resolveChatStartDefaults } from "./chat-settings";
import {
  assertNoAmbiguousExactPatterns,
  scopeWarnings,
  selectInitialModelScope,
  thinkingLevelPinsOf,
  type CatalogueModel,
  type CatalogueScopeResult,
  type CatalogueScopedModel,
  type ScopeDiagnosticLike,
} from "./model-scope-policy";
import { withModelRuntimeError, type ModelsData } from "./models-cache";

/**
 * The model catalogue as plain data, built off the main thread.
 *
 * `GET /api/models` answers the composer's model selector, and it is the first
 * request after the window appears. Building the catalogue needs
 * `createAgentSessionServices` from the pi SDK, whose root import loads a 37 MB
 * ESM graph — measured at 2.6–2.9 s of **blocked event loop** inside the
 * packaged Node, six cold starts out of six (DEFECT-000101). None of that work
 * needs the server's own thread: it reads settings and provider metadata and
 * produces JSON.
 *
 * So `lib/models-worker.ts` runs it in a `worker_threads` worker, and this
 * module turns the reply into the same `ModelsData` the route always returned.
 * The scope policy, the default-model pick and the warnings stay here, in
 * TypeScript, over plain `{ provider, id, name, input }` records; the worker
 * performs the SDK calls and nothing else (`lib/models-worker-source.ts`).
 */

/** What the worker is asked for. Everything here must survive structured clone. */
export interface ModelCatalogueRequest {
  cwd: string;
  agentDir: string;
  /**
   * The project-trust verdict, resolved on the caller's side: the SDK takes a
   * `resolveProjectTrust()` closure, which cannot cross a thread boundary.
   * `null` means "this folder does not require trust" (no reload options).
   */
  trusted: boolean | null;
}

/** One model as the worker reports it. */
export interface CatalogueModelRecord {
  provider: string;
  id: string;
  name: string;
  input?: string[];
}

/** What the worker replies with: SDK facts only, no decisions. */
export interface ModelCatalogueSnapshot {
  /** `modelRuntime.getError()`, or null. */
  modelError: string | null;
  /** `getAvailable()` — the models with usable credentials, in runtime order. */
  available: CatalogueModelRecord[];
  /** `getModels()` — the full catalogue, used to reword `no-match` warnings. */
  catalogue: { provider: string; id: string; name?: string }[];
  authenticatedProviders: string[];
  /** `enabledModels`, already trimmed. */
  enabledPatterns: string[];
  /** Resolver order; empty when no patterns were configured or none matched. */
  scoped: { provider: string; id: string; thinkingLevel: string | null }[];
  diagnostics: ScopeDiagnosticLike[];
  /** `provider:id` → the thinking levels the model supports. */
  thinkingLevels: Record<string, string[]>;
  /** `provider:id` → the model's own level mapping, when it has one. */
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
  /** `provider:id` → the level saved for that model in settings. */
  modelThinkingLevels: Record<string, string>;
  settings: {
    defaultProvider: string | null;
    defaultModel: string | null;
    defaultThinkingLevel: string | null;
  };
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function modelThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
  return value && THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : undefined;
}

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}:${model.id}`;
}

/**
 * Turn the worker's SDK facts into the resolved scope.
 *
 * Same policy the in-process resolver applies (`scopeWarnings`,
 * `assertNoAmbiguousExactPatterns`), only over the plain records the worker
 * returned — one implementation, two data sources.
 */
export function resolveVisibleFromCatalogue(
  snapshot: ModelCatalogueSnapshot,
): CatalogueScopeResult {
  const available: CatalogueModel[] = snapshot.available.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    ...(model.input ? { input: model.input } : {}),
  }));

  if (snapshot.enabledPatterns.length === 0) {
    return { visible: available, scopedModels: [], thinkingLevelPins: {}, warnings: [] };
  }

  // Throws for exact patterns that match several models; the route turns that
  // into the same safe failure the in-process resolver produced.
  assertNoAmbiguousExactPatterns(snapshot.enabledPatterns, available);

  const byKey = new Map(available.map((model) => [modelKey(model), model]));
  const scopedModels: CatalogueScopedModel[] = snapshot.scoped.map((entry) => {
    const model = byKey.get(`${entry.provider}:${entry.id}`)
      ?? { provider: entry.provider, id: entry.id, name: entry.id };
    const thinkingLevel = modelThinkingLevel(entry.thinkingLevel);
    return { model, ...(thinkingLevel ? { thinkingLevel } : {}) };
  });

  const warnings = scopeWarnings(snapshot.diagnostics, scopedModels.length, {
    models: snapshot.catalogue,
    isAuthenticated: (providerId) => snapshot.authenticatedProviders.includes(providerId),
  });
  if (scopedModels.length === 0) {
    return { visible: available, scopedModels: [], thinkingLevelPins: {}, warnings };
  }
  return {
    visible: scopedModels.map((scoped) => scoped.model),
    scopedModels,
    thinkingLevelPins: thinkingLevelPinsOf(scopedModels),
    warnings,
  };
}

/**
 * The response body `GET /api/models` sends, assembled from the worker snapshot.
 *
 * Kept compatible with the in-process version it replaces: the same name map,
 * the same `modelList` order (collator, name then provider then id), the same
 * default model and thinking level, and the same `modelError` handling.
 */
export function modelsDataFromCatalogue(
  snapshot: ModelCatalogueSnapshot,
  options: { cwd: string },
): ModelsData {
  const scope = resolveVisibleFromCatalogue(snapshot);
  const availableByKey = new Map(snapshot.available.map((model) => [modelKey(model), model]));

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const nameMap = new Map<string, string>();
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  for (const model of scope.visible) {
    const key = modelKey(model);
    // The SDK's own display name wins; `scope.visible` may carry a scoped copy.
    nameMap.set(key, availableByKey.get(key)?.name ?? model.name);
    thinkingLevels[key] = snapshot.thinkingLevels[key] ?? [];
    const map = snapshot.thinkingLevelMaps[key];
    if (map) thinkingLevelMaps[key] = map;
  }
  const modelList = scope.visible
    .map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      ...(model.input ? { input: model.input } : {}),
    }))
    .sort((a, b) => collator.compare(a.name || a.id, b.name || b.id)
      || collator.compare(a.provider, b.provider)
      || collator.compare(a.id, b.id));

  // A new chat starts on the model and reasoning level chosen in Settings › Chats,
  // so the composer must show the same ones the server will start with.
  const chatStart = isChatWorkspacePath(options.cwd)
    ? resolveChatStartDefaults(readChatSettings(), scope.visible)
    : {};
  const initial = selectInitialModelScope(scope, {
    ...(chatStart.requestedModel ? { requestedModel: chatStart.requestedModel } : {}),
    ...(chatStart.thinkingLevel ? { thinkingLevel: chatStart.thinkingLevel } : {}),
    ...(snapshot.settings.defaultProvider && snapshot.settings.defaultModel
      ? {
          defaultModel: {
            provider: snapshot.settings.defaultProvider,
            modelId: snapshot.settings.defaultModel,
          },
        }
      : {}),
  });
  const defaultThinkingLevel = initial.thinkingLevel
    ?? (initial.model ? modelThinkingLevel(snapshot.modelThinkingLevels[modelKey(initial.model)]) : undefined)
    ?? modelThinkingLevel(snapshot.settings.defaultThinkingLevel)
    ?? null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel: initial.model
        ? { provider: initial.model.provider, modelId: initial.model.id }
        : null,
      defaultThinkingLevel,
      savedDefaultThinkingLevel: snapshot.settings.defaultThinkingLevel,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins: scope.thinkingLevelPins,
      ...(scope.warnings.length > 0 ? { modelScopeWarnings: scope.warnings } : {}),
    },
    snapshot.modelError ?? undefined,
  );
}

/** Chat folders share the chat root's cache entry instead of a cold load each. */
export function modelsCacheKey(cwd: string, chatWorkspaceDir: () => string): string {
  return isChatFolderPath(cwd) ? chatWorkspaceDir() : cwd;
}
