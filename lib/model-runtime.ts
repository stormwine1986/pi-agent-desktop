import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { agentDir as agentDirectory } from "./agent-dir";

/**
 * ModelRuntime that also includes providers registered by extensions (an
 * extension that calls `registerProvider` / `createProvider` during resource
 * loading). A bare `ModelRuntime.create()` only knows built-in providers plus
 * models.json, so extension-registered providers were invisible to the
 * provider-listing and auth routes.
 *
 * The agent dir acts as cwd so project-local extensions stay out; global
 * package extensions always load. Not cached: these routes need fresh
 * credentials for auth status and login/logout to be truthful.
 */
export async function createModelRuntimeWithExtensions(
  modelRuntime?: ModelRuntime,
): Promise<ModelRuntime> {
  // Imported at the call, not with the module (TASK-000113): MCP's test
  // connection reaches this file from the first screen's project-trust
  // listing, where one static symbol from the SDK root would load the whole
  // 37 MB graph before the window can be shown.
  const { createAgentSessionServices, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const agentDir = agentDirectory();
  const runtime = modelRuntime ?? await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const services = await createAgentSessionServices({
    cwd: agentDir,
    agentDir,
    modelRuntime: runtime,
    resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
  });
  return services.modelRuntime;
}
