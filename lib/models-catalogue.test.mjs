import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { resolveVisibleFromCatalogue, modelsDataFromCatalogue } = await jiti.import("./models-catalogue.ts");

/**
 * The catalogue's SDK facts are produced in a worker thread (DEFECT-000101);
 * these tests feed the same JSON shape the worker posts back and check that the
 * decisions on this side still follow the rules the in-process resolver had.
 */

function snapshot(overrides = {}) {
  return {
    modelError: null,
    available: [
      { provider: "alpha", id: "one", name: "Alpha One", input: ["text"] },
      { provider: "alpha", id: "two", name: "Alpha Two" },
      { provider: "beta", id: "one", name: "Beta One" },
    ],
    catalogue: [
      { provider: "alpha", id: "one", name: "Alpha One" },
      { provider: "alpha", id: "two", name: "Alpha Two" },
      { provider: "beta", id: "one", name: "Beta One" },
      { provider: "gamma", id: "hidden", name: "Gamma Hidden" },
    ],
    authenticatedProviders: ["alpha", "beta"],
    enabledPatterns: [],
    scoped: [],
    diagnostics: [],
    thinkingLevels: { "alpha:one": ["off", "high"], "alpha:two": ["off"], "beta:one": ["off"] },
    thinkingLevelMaps: { "alpha:one": { high: "high" } },
    modelThinkingLevels: {},
    settings: { defaultProvider: null, defaultModel: null, defaultThinkingLevel: null },
    ...overrides,
  };
}

test("no patterns means every available model, in runtime order", () => {
  const scope = resolveVisibleFromCatalogue(snapshot());
  assert.deepEqual(scope.visible.map((m) => `${m.provider}/${m.id}`), ["alpha/one", "alpha/two", "beta/one"]);
  assert.deepEqual(scope.scopedModels, []);
  assert.deepEqual(scope.thinkingLevelPins, {});
  assert.deepEqual(scope.warnings, []);
});

test("a scoped entry resolves to the available model and keeps its thinking pin", () => {
  const scope = resolveVisibleFromCatalogue(snapshot({
    enabledPatterns: ["alpha/*:high"],
    scoped: [
      { provider: "alpha", id: "one", thinkingLevel: "high" },
      { provider: "alpha", id: "two", thinkingLevel: "high" },
    ],
  }));
  assert.deepEqual(scope.visible.map((m) => `${m.provider}/${m.id}`), ["alpha/one", "alpha/two"]);
  assert.deepEqual(scope.thinkingLevelPins, { "alpha/one": "high", "alpha/two": "high" });
  assert.equal(scope.scopedModels[0].thinkingLevel, "high");
});

test("a pattern that matches nothing falls back to every available model but still warns", () => {
  const scope = resolveVisibleFromCatalogue(snapshot({
    enabledPatterns: ["alpha/nope"],
    diagnostics: [{ code: "no-match", pattern: "alpha/nope", message: "no model matched alpha/nope" }],
  }));
  assert.equal(scope.visible.length, 3);
  assert.deepEqual(scope.scopedModels, []);
  assert.equal(scope.warnings.length, 1);
  assert.equal(scope.warnings[0].code, "no-match");
});

test("a no-match on a provider with no credentials is reworded, not shown as a typo", () => {
  const scope = resolveVisibleFromCatalogue(snapshot({
    enabledPatterns: ["gamma/*"],
    diagnostics: [{ code: "no-match", pattern: "gamma/*", message: "no model matched gamma/*" }],
  }));
  assert.equal(scope.warnings.length, 1);
  assert.equal(scope.warnings[0].code, "unauthenticated-provider");
  assert.deepEqual(scope.warnings[0].unauthenticatedProviders, ["gamma"]);
});

test("a leftover unmatched glob is suppressed once another pattern matched", () => {
  const scope = resolveVisibleFromCatalogue(snapshot({
    enabledPatterns: ["alpha/*", "beta/gone*"],
    scoped: [
      { provider: "alpha", id: "one", thinkingLevel: null },
      { provider: "alpha", id: "two", thinkingLevel: null },
    ],
    diagnostics: [{ code: "no-match", pattern: "beta/gone*", message: "no model matched beta/gone*" }],
  }));
  assert.deepEqual(scope.warnings, []);
  assert.equal(scope.visible.length, 2);
});

test("an exact pattern matching several models still throws, as the in-process resolver did", () => {
  assert.throws(
    () => resolveVisibleFromCatalogue(snapshot({ enabledPatterns: ["one"] })),
    /Ambiguous enabledModels entry "one" matches multiple models/,
  );
});

test("the response keeps the saved default when it is in scope, and its thinking level", () => {
  const data = modelsDataFromCatalogue(snapshot({
    settings: { defaultProvider: "alpha", defaultModel: "two", defaultThinkingLevel: "medium" },
    modelThinkingLevels: { "alpha:two": "low" },
  }), { cwd: "D:/projects/entity-assistant" });
  assert.deepEqual(data.defaultModel, { provider: "alpha", modelId: "two" });
  assert.equal(data.defaultThinkingLevel, "low");
  assert.equal(data.savedDefaultThinkingLevel, "medium");
});

test("the default model never leaves the enabled scope", () => {
  const data = modelsDataFromCatalogue(snapshot({
    settings: { defaultProvider: "beta", defaultModel: "one", defaultThinkingLevel: null },
    enabledPatterns: ["alpha/one"],
    scoped: [{ provider: "alpha", id: "one", thinkingLevel: null }],
  }), { cwd: "D:/projects/entity-assistant" });
  assert.deepEqual(data.defaultModel, { provider: "alpha", modelId: "one" });
});

test("modelList is sorted the way the selector expects and carries input modalities", () => {
  const data = modelsDataFromCatalogue(snapshot(), { cwd: "D:/projects/entity-assistant" });
  assert.deepEqual(data.modelList.map((m) => m.name), ["Alpha One", "Alpha Two", "Beta One"]);
  assert.deepEqual(data.modelList[0].input, ["text"]);
  assert.deepEqual(data.thinkingLevels["alpha:one"], ["off", "high"]);
  assert.deepEqual(data.thinkingLevelMaps["alpha:one"], { high: "high" });
  assert.equal(data.modelError, undefined);
});

test("a runtime error is reported beside the list instead of replacing it", () => {
  const data = modelsDataFromCatalogue(snapshot({ modelError: "provider alpha failed" }), {
    cwd: "D:/projects/entity-assistant",
  });
  assert.equal(data.modelError, "provider alpha failed");
  assert.equal(data.modelList.length, 3);
});
