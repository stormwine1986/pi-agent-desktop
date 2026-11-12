import { stat } from "fs/promises";
import { resolve } from "path";
import { agentDir as agentDirectory } from "@/lib/agent-dir";
import { peekModelsCache, withSafeModelLoadFailure, type ModelsData } from "@/lib/models-cache";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { chatWorkspaceDir } from "@/lib/chat-workspace";
import { modelsCacheKey, modelsDataFromCatalogue } from "@/lib/models-catalogue";
import { loadModelCatalogue } from "@/lib/models-worker";

export const dynamic = "force-dynamic";

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  defaultThinkingLevel: null,
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

/**
 * The catalogue is built in a worker thread (DEFECT-000101).
 *
 * This route answers the composer's model selector, and it is the first request
 * after the window appears. Building the list needs the pi SDK, whose root
 * import blocks the event loop for 2.6–2.9 s inside the packaged Node — the
 * freeze every cold start reported (`event loop blocked for 2751–2999 ms`,
 * ended +5.6–+6.0 s, while the user was already interacting). The work itself is
 * a read: `lib/models-worker.ts` runs it off-thread and this route assembles the
 * response from plain JSON, so nothing here may load the SDK — not statically
 * and not with a dynamic `import()` (see `lib/first-screen-graph.test.mjs`).
 */
async function loadModels(cwd: string): Promise<ModelsData> {
  const agentDir = agentDirectory();
  // The SDK wants a `resolveProjectTrust()` closure; resolve the verdict here,
  // where the trust file is already read on every prompt, and hand the worker a
  // boolean (a closure cannot cross the thread boundary).
  const trust = projectTrustReloadOptions(cwd, agentDir);
  const trusted = trust ? await trust.resolveProjectTrust() : null;
  const snapshot = await loadModelCatalogue({ cwd, agentDir, trusted });
  return modelsDataFromCatalogue(snapshot, { cwd });
}

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = resolve(requestedCwd);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  // Never await the SDK here (DEFECT-000101). A fresh or stale list answers now;
  // with none at all this answers a placeholder and the warm runs in the
  // background. `modelsPending` tells the client to fetch again in a moment, so
  // an empty selector is always followed by the real list, not left standing.
  //
  // Every chat folder gets the same list (same chat policy, no project config),
  // so they share the chat root's entry instead of a cold load for each chat opened.
  const cacheKey = modelsCacheKey(cwd, chatWorkspaceDir);
  try {
    const peeked = peekModelsCache(cacheKey, () => loadModels(cwd));
    if (!peeked.data) {
      return Response.json({ ...EMPTY_MODELS, modelsPending: true });
    }
    return Response.json(peeked.pending ? { ...peeked.data, modelsPending: true } : peeked.data);
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
