import type {
  ModelRuntime,
  ScopedModel,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelScopeWarning } from "./model-scope-warnings";
import {
  assertNoAmbiguousExactPatterns,
  scopeWarnings,
  thinkingLevelPinsOf,
} from "./model-scope-policy";

/**
 * Model scoping shared by the UI selector and AgentSession startup.
 *
 * The `enabledModels` setting uses the same syntax as pi's `--models` flag:
 * globs matched with minimatch against `provider/modelId` or a bare `modelId`,
 * fuzzy matching for non-glob patterns, plus an optional `:thinkingLevel` suffix
 * (`anthropic/*:high`). Exact string comparison silently drops every model
 * behind a pattern like `my-gateway/*` (#307), so delegate to pi's own resolver
 * instead of reimplementing the matching rules here.
 *
 * The *rules* live in `lib/model-scope-policy.ts` (pure, SDK-free): the same
 * implementation answers the worker-backed catalogue (`lib/models-catalogue.ts`)
 * and this in-process adapter, which is the only half that touches a
 * `ModelRuntime`.
 */

export * from "./model-scope-policy";

export interface ModelScopeResult {
  /** Models the UI should offer, in resolver order (all available when unscoped). */
  visible: readonly Model<Api>[];
  /** SDK-native scope retained for AgentSession model cycling and extensions. */
  scopedModels: readonly ScopedModel[];
  /** `provider/modelId` → thinking level pinned with a `:level` pattern suffix. */
  thinkingLevelPins: Record<string, string>;
  /** Resolver diagnostics, e.g. a pattern that matched no model. */
  warnings: ModelScopeWarning[];
}

/**
 * Resolve the visible model list for `patterns`.
 *
 * Falls back to every available model when no patterns are configured or when
 * the patterns resolve to nothing, so a stale or typo'd setting can never leave
 * the UI without any selectable model.
 */
export async function resolveVisibleModels(
  modelRuntime: ModelRuntime,
  patterns: string[] | undefined,
): Promise<ModelScopeResult> {
  const cleaned = (patterns ?? []).map((pattern) => pattern.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return {
      visible: await modelRuntime.getAvailable(),
      scopedModels: [],
      thinkingLevelPins: {},
      warnings: [],
    };
  }

  const available = await modelRuntime.getAvailable();
  assertNoAmbiguousExactPatterns(cleaned, available);
  const snapshotRuntime = {
    getAvailable: async () => available,
  } as ModelRuntime;
  // Imported at the call: this module is reachable from the first screen's
  // model list, which must not load the SDK statically (TASK-000113).
  const { resolveModelScopeWithDiagnostics } = await import("@earendil-works/pi-coding-agent");
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(cleaned, snapshotRuntime);
  const warnings = scopeWarnings(diagnostics, scopedModels.length, {
    models: modelRuntime.getModels(),
    isAuthenticated: (providerId) => modelRuntime.hasConfiguredAuth(providerId),
  });
  if (scopedModels.length === 0) {
    return {
      visible: available,
      scopedModels: [],
      thinkingLevelPins: {},
      warnings,
    };
  }

  return {
    visible: scopedModels.map((scoped) => scoped.model),
    scopedModels,
    thinkingLevelPins: thinkingLevelPinsOf(scopedModels),
    warnings,
  };
}

