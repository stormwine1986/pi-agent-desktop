import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  findUnauthenticatedProvidersForPattern,
  type CatalogModelRef,
  type ModelScopeWarning,
} from "./model-scope-warnings";

/**
 * The `enabledModels` scope rules, as pure functions over plain model records.
 *
 * Split out of `lib/model-scope.ts` for the same reason the session catalogue is
 * split (`lib/session-list.ts`): `GET /api/models` answers the first model-list
 * request after the window appears, and its data is built in a worker thread
 * (DEFECT-000101), so the modules it reaches must not import the SDK — not even
 * to type the runtime. The in-process adapter that owns the SDK's `ModelRuntime`
 * (`resolveVisibleModels`) lives in `lib/model-scope.ts` and re-exports these.
 */

const THINKING_LEVEL_SUFFIXES = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * The catalogue's own scope result: the same shape as `ModelScopeResult` over
 * plain data instead of SDK `Model` instances.
 *
 * `GET /api/models` must not load the pi SDK on the request path (DEFECT-000101:
 * a 2.7–3.0 s blocked loop every cold start, on the first model-list request
 * after the window appears), so that catalogue is built in a worker thread
 * (`lib/models-worker.ts`) and comes back as JSON. Everything downstream of the
 * resolution — the default pick, the pins, the selector rows — only ever reads
 * `provider`/`id`/`name`/`input`, so this is the same data, not a parallel rule.
 */
export interface CatalogueModel {
  provider: string;
  id: string;
  name: string;
  input?: string[];
}

export interface CatalogueScopedModel {
  model: CatalogueModel;
  thinkingLevel?: ThinkingLevel;
}

export interface CatalogueScopeResult {
  visible: readonly CatalogueModel[];
  scopedModels: readonly CatalogueScopedModel[];
  thinkingLevelPins: Record<string, string>;
  warnings: ModelScopeWarning[];
}

/** What the warning classifier needs from whichever runtime produced the scope. */
export interface ScopeLookup {
  /** The full catalogue (not just the available subset), for `no-match` rewording. */
  models: readonly CatalogModelRef[];
  isAuthenticated: (providerId: string) => boolean;
}

/**
 * The part of pi's resolver diagnostic the classifier reads.
 *
 * Structural on purpose: the in-process resolver hands over the SDK's own
 * `ModelScopeDiagnostic` (which also carries `type: "warning"`), the worker
 * hands over the same three fields as JSON.
 */
export interface ScopeDiagnosticLike {
  code: "no-match" | "invalid-thinking-level" | "ambiguous";
  pattern: string;
  message: string;
}

/**
 * Classify one resolver diagnostic for display.
 *
 * pi's `no-match` fires against `getAvailable()`, which drops every model of a
 * provider without usable credentials — so a healthy pattern for an
 * unauthenticated provider is misreported as a typo (#48). Cross-check the
 * full catalog against `hasConfiguredAuth()` and rewrite that case into an
 * `unauthenticated-provider` warning; everything else keeps the raw message.
 */
function classifyDiagnostic(
  diagnostic: ScopeDiagnosticLike,
  lookup: ScopeLookup,
): ModelScopeWarning {
  if (diagnostic.code !== "no-match") {
    return { code: diagnostic.code, pattern: diagnostic.pattern, message: diagnostic.message };
  }
  try {
    const unauthenticated = findUnauthenticatedProvidersForPattern(
      diagnostic.pattern,
      lookup.models,
      lookup.isAuthenticated,
    );
    if (unauthenticated && unauthenticated.length > 0) {
      return {
        code: "unauthenticated-provider",
        pattern: diagnostic.pattern,
        unauthenticatedProviders: unauthenticated,
        message: diagnostic.message,
      };
    }
  } catch {
    // Classification is best-effort; the raw resolver message still surfaces.
  }
  return { code: diagnostic.code, pattern: diagnostic.pattern, message: diagnostic.message };
}

export interface InitialModelScopeOptions {
  requestedModel?: { provider: string; modelId: string };
  defaultModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export interface InitialModelScopeResult<M extends ModelRef = ModelRef> {
  model?: M;
  thinkingLevel?: ThinkingLevel;
  scopedModels: { model: M; thinkingLevel?: ThinkingLevel }[];
}

/** The only part of a model a scope decision reads. */
export interface ModelRef {
  provider: string;
  id: string;
}

/** A resolved scope, whether it came from the SDK runtime or the worker catalogue. */
export interface ModelScopeSelection<M extends ModelRef> {
  visible: readonly M[];
  scopedModels: readonly { model: M; thinkingLevel?: ThinkingLevel }[];
}

function matchesModel(
  model: { provider: string; id: string },
  ref: { provider: string; modelId: string },
): boolean {
  return model.provider === ref.provider && model.id === ref.modelId;
}

function hasGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function isSuppressibleUnmatchedGlob(pattern: string): boolean {
  if (!hasGlob(pattern)) return false;
  const colonIndex = pattern.lastIndexOf(":");
  return colonIndex < 0
    || THINKING_LEVEL_SUFFIXES.has(pattern.slice(colonIndex + 1) as ThinkingLevel);
}

function exactReferenceMatches<M extends ModelRef>(pattern: string, models: readonly M[]): M[] {
  const normalized = pattern.toLowerCase();
  const canonical = models.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
  );
  if (canonical.length > 0) return canonical;
  return models.filter((model) => model.id.toLowerCase() === normalized);
}

export function assertNoAmbiguousExactPatterns(
  patterns: readonly string[],
  models: readonly ModelRef[],
): void {
  for (const pattern of patterns) {
    if (hasGlob(pattern)) continue;

    let matches = exactReferenceMatches(pattern, models);
    if (matches.length === 0) {
      const colonIndex = pattern.lastIndexOf(":");
      const suffix = colonIndex >= 0 ? pattern.slice(colonIndex + 1) : "";
      if (THINKING_LEVEL_SUFFIXES.has(suffix as ThinkingLevel)) {
        matches = exactReferenceMatches(pattern.slice(0, colonIndex), models);
      }
    }

    if (matches.length > 1) {
      const references = matches
        .map((model) => `${model.provider}/${model.id}`)
        .sort()
        .join(", ");
      throw new Error(
        `Ambiguous enabledModels entry "${pattern}" matches multiple models: ${references}. Use provider/modelId.`,
      );
    }
  }
}

/**
 * The fork's policy on top of pi's resolver output, shared by the in-process
 * runtime above and the worker-backed catalogue (`lib/models-catalogue.ts`).
 *
 * A leftover valid glob after a model was removed is not a chat-level problem
 * when other enabledModels entries still matched. Keep exact and malformed
 * pattern warnings, and keep all no-match warnings for a total miss, where the
 * UI falls back to every available model and the user needs to know the scope
 * did not apply.
 */
export function scopeWarnings(
  diagnostics: readonly ScopeDiagnosticLike[],
  matchedCount: number,
  lookup: ScopeLookup,
): ModelScopeWarning[] {
  return diagnostics
    .filter((diagnostic) => (
      diagnostic.code !== "no-match"
      || matchedCount === 0
      || !isSuppressibleUnmatchedGlob(diagnostic.pattern)
    ))
    .map((diagnostic) => classifyDiagnostic(diagnostic, lookup));
}

/** `anthropic/*:high` pins a thinking level on every model the glob matched. */
export function thinkingLevelPinsOf(
  scopedModels: readonly { model: { provider: string; id: string }; thinkingLevel?: string }[],
): Record<string, string> {
  // pi applies the pin of the model a new session starts with; report them all
  // so the client can look up whichever model it pre-selects.
  const pins: Record<string, string> = {};
  for (const scoped of scopedModels) {
    if (scoped.thinkingLevel) {
      pins[`${scoped.model.provider}/${scoped.model.id}`] = scoped.thinkingLevel;
    }
  }
  return pins;
}

/**
 * Select the model and thinking level used to create a new AgentSession.
 *
 * This mirrors pi's startup rule: prefer an explicit selection, otherwise use
 * the saved default when it is in scope, then the first resolver-ordered model.
 * A scoped-model thinking pin is applied unless the caller supplied an explicit
 * thinking level.
 */
export function selectInitialModelScope<M extends ModelRef>(
  scope: ModelScopeSelection<M>,
  options: InitialModelScopeOptions = {},
): InitialModelScopeResult<M> {
  const requestedRef = options.requestedModel;
  const defaultRef = options.defaultModel;
  const requested = requestedRef
    ? scope.visible.find((model) => matchesModel(model, requestedRef))
    : undefined;
  if (requestedRef && !requested) {
    throw new Error(
      `Model is not available in the enabled scope: ${requestedRef.provider}/${requestedRef.modelId}`,
    );
  }

  const requestedScoped = requested
    ? scope.scopedModels.find((scoped) => scoped.model === requested
      || matchesModel(scoped.model, { provider: requested.provider, modelId: requested.id }))
    : undefined;
  const defaultScoped = !requested && defaultRef
    ? scope.scopedModels.find((scoped) => matchesModel(scoped.model, defaultRef))
    : undefined;
  const fallbackScoped = !requested ? (defaultScoped ?? scope.scopedModels[0]) : undefined;
  const defaultVisible = !requested && !fallbackScoped && defaultRef
    ? scope.visible.find((model) => matchesModel(model, defaultRef))
    : undefined;
  const selectedModel = requested ?? fallbackScoped?.model ?? defaultVisible;
  const scopedSelection = requestedScoped ?? fallbackScoped;
  const thinkingLevel = options.thinkingLevel ?? scopedSelection?.thinkingLevel;

  return {
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    scopedModels: [...scope.scopedModels],
  };
}
