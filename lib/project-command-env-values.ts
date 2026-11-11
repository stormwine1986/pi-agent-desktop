// The pure half of `lib/project-command-env.ts`: which host variables a
// project command must not inherit. Split out for the first screen
// (TASK-000113): `lib/mcp-transport.ts` (reached from project-trust's MCP
// listing) needs this function only, and the module it used to live in imports
// the pi SDK's bash tool for its extension factory — a 37 MB server-external
// graph, ~1.4 s of blocked loop, on a request that only lists files.

function isHostRuntimeVariable(name: string, platform: NodeJS.Platform): boolean {
  const comparableName = platform === "win32" ? name.toUpperCase() : name;
  return comparableName === "PORT"
    || comparableName === "NODE_ENV"
    || comparableName.startsWith("NEXT_")
    // The browser login password guards this server; commands run on behalf of
    // a project (and the model reading their output) have no use for it.
    || comparableName === "PI_WEB_PASSWORD";
}

/** The environment a project command runs with: this server's own variables removed. */
export function sanitizeProjectCommandEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (isHostRuntimeVariable(name, platform)) delete environment[name];
  }
  return environment;
}
