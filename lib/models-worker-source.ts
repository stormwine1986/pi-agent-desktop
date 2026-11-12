/**
 * The body of the model-catalogue worker (`lib/models-worker.ts`).
 *
 * It is a string because a worker that needs a *file* would have to be traced
 * into the Next standalone payload, and `outputFileTracingExcludes` is inert on
 * Windows (see `docs/agents/fork-desktop.md`) — a `new Worker(path)` whose file
 * the payload does not carry fails at runtime with a defect-shaped error,
 * which is exactly how DEFECT-000092 disabled MCP for a whole release. An
 * `eval` worker carries no file: the payload needs nothing new.
 *
 * The code is deliberately thin: import the pi SDK, read the model runtime and
 * settings, and post plain JSON back. Every decision (scope policy, default
 * model, warnings) stays on the server thread in `lib/models-catalogue.ts`.
 * `lib/models-worker.test.mjs` pins the contract: no decisions here, no reply
 * that cannot survive structured clone.
 *
 * Loaded by file URL rather than by bare specifier for the same reason
 * `lib/pi-sdk-internals.ts` does: the package exports `types`/`import` only, so
 * a CommonJS `require` is unresolved, and a bundled bare `import()` becomes
 * webpack's throwing placeholder. `lib/models-worker.ts` resolves both entries
 * from the running server's own `node_modules`.
 */
export const MODELS_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

let sdkPromise = null;
let aiPromise = null;

function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import(workerData.sdkEntry).catch(() => import("@earendil-works/pi-coding-agent"));
  }
  return sdkPromise;
}

function loadAi() {
  if (!aiPromise) {
    aiPromise = import(workerData.aiEntry).catch(() => import("@earendil-works/pi-ai"));
  }
  return aiPromise;
}

function plainModel(model) {
  const record = { provider: model.provider, id: model.id, name: model.name };
  if (Array.isArray(model.input)) record.input = model.input;
  return record;
}

async function buildCatalogue(request) {
  const sdk = await loadSdk();
  const ai = await loadAi();

  const services = await sdk.createAgentSessionServices({
    cwd: request.cwd,
    agentDir: request.agentDir,
    ...(request.trusted === null || request.trusted === undefined
      ? {}
      : { resourceLoaderReloadOptions: { resolveProjectTrust: async () => request.trusted } }),
  });

  const runtime = services.modelRuntime;
  const settings = services.settingsManager;
  const available = await runtime.getAvailable();
  const catalogue = runtime.getModels();
  const enabledPatterns = (settings.getEnabledModels() || [])
    .map((pattern) => String(pattern).trim())
    .filter(Boolean);

  let scoped = [];
  let diagnostics = [];
  if (enabledPatterns.length > 0) {
    // The resolver runs here because it takes the runtime's own model objects;
    // only its verdicts (ids, levels, messages) leave the thread.
    const resolved = await sdk.resolveModelScopeWithDiagnostics(enabledPatterns, {
      getAvailable: async () => available,
    });
    scoped = resolved.scopedModels.map((entry) => ({
      provider: entry.model.provider,
      id: entry.model.id,
      thinkingLevel: entry.thinkingLevel || null,
    }));
    diagnostics = resolved.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      pattern: diagnostic.pattern,
      message: diagnostic.message,
    }));
  }

  const thinkingLevels = {};
  const thinkingLevelMaps = {};
  const modelThinkingLevels = {};
  const availableRecords = [];
  for (const model of available) {
    const key = model.provider + ":" + model.id;
    availableRecords.push(plainModel(model));
    try {
      thinkingLevels[key] = ai.getSupportedThinkingLevels(model);
    } catch {
      thinkingLevels[key] = [];
    }
    if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
    try {
      const level = settings.getModelThinkingLevel(model.provider, model.id);
      if (level) modelThinkingLevels[key] = level;
    } catch {
      /* a model without a saved level contributes nothing */
    }
  }

  const authenticatedProviders = [];
  for (const provider of new Set(catalogue.map((model) => model.provider))) {
    let authenticated = false;
    try {
      authenticated = Boolean(runtime.hasConfiguredAuth(provider));
    } catch {
      authenticated = false;
    }
    if (authenticated) authenticatedProviders.push(provider);
  }

  return {
    modelError: runtime.getError() || null,
    available: availableRecords,
    catalogue: catalogue.map((model) => ({
      provider: model.provider,
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
    })),
    authenticatedProviders,
    enabledPatterns,
    scoped,
    diagnostics,
    thinkingLevels,
    thinkingLevelMaps,
    modelThinkingLevels,
    settings: {
      defaultProvider: settings.getDefaultProvider() || null,
      defaultModel: settings.getDefaultModel() || null,
      defaultThinkingLevel: settings.getDefaultThinkingLevel() || null,
    },
  };
}

parentPort.on("message", (message) => {
  if (!message || typeof message.id !== "number") return;
  const id = message.id;
  buildCatalogue(message.request)
    .then((value) => parentPort.postMessage({ id, ok: true, value }))
    .catch((error) => parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
});
`;
