import type {
  LoadedMcpConfig,
  McpExposure,
  McpExtensionOptions,
  McpServerConfig,
  McpServerEntry,
  McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePackageImportEntryFrom } from "./package-entry";

// MCP support the SDK ships but its package does not export (ADR 0006): the
// connection class, the stdio transport, the `mcp.json` editor and OAuth
// sign-in. They are loaded by file URL from the same SDK copy pi-web runs, so
// that `instanceof` checks inside the SDK see the classes pi-web constructs.
// An SDK upgrade that moves or renames any of them turns MCP off with a reason
// instead of misbehaving; `lib/pi-sdk-internals.test.mjs` pins the contract.

const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const MCP_PACKAGE = "@earendil-works/pi-mcp";

/**
 * The package root's `import` entry — `exports["."].import`, which is all the
 * manifest offers (`types` and `import`, no `require`). Loaded as a file URL
 * like every module below, never as the bare specifier (DEFECT-000092).
 */
const SDK_ENTRY = "dist/index.js";

const SDK_MODULES = {
  mcpExtension: "dist/extensions/mcp/index.js",
  mcpRuntime: "dist/extensions/mcp/runtime.js",
  mcpConfig: "dist/extensions/mcp/config.js",
  mcpOAuth: "dist/extensions/mcp/oauth.js",
  mcpServers: "dist/core/mcp-servers.js",
  configValues: "dist/core/resolve-config-value.js",
} as const;

type SdkModuleName = keyof typeof SDK_MODULES | "mcpClient";
type MemberKind = "class" | "function";

const MEMBERS = {
  McpServerConnection: { module: "mcpRuntime", kind: "class" },
  createDefaultTransport: { module: "mcpRuntime", kind: "function" },
  StdioTransport: { module: "mcpClient", kind: "class" },
  loadMcpConfig: { module: "mcpConfig", kind: "function" },
  addMcpServerConfig: { module: "mcpConfig", kind: "function" },
  updateMcpServerConfig: { module: "mcpConfig", kind: "function" },
  removeMcpServerConfig: { module: "mcpConfig", kind: "function" },
  validateMcpServerConfig: { module: "mcpServers", kind: "function" },
  getMcpToolExposure: { module: "mcpServers", kind: "function" },
  signInMcpServer: { module: "mcpOAuth", kind: "function" },
  McpOAuthCredentialStore: { module: "mcpOAuth", kind: "class" },
  McpSignInCancelledError: { module: "mcpOAuth", kind: "class" },
  resolveConfigValueOrThrow: { module: "configValues", kind: "function" },
  resolveHeadersOrThrow: { module: "configValues", kind: "function" },
  getConfigValueEnvVarNames: { module: "configValues", kind: "function" },
  isCommandConfigValue: { module: "configValues", kind: "function" },
} as const satisfies Record<string, { module: SdkModuleName; kind: MemberKind }>;

/** What a transport factory returns: pi-mcp's `McpTransport`, which the SDK root does not export. */
export type McpTransport = ReturnType<McpTransportFactory>;

/** The SDK's `McpOAuthCredentialStore`: per-server OAuth state in `<agent-dir>/mcp-auth.json`. */
export type McpOAuthCredentialStore = NonNullable<McpExtensionOptions["credentials"]>;

/** One server's slice of the credential store. */
export type McpOAuthServerStore = ReturnType<McpOAuthCredentialStore["forServer"]>;

/** pi-mcp's `McpOAuthStateStore`, which sign-in reads and writes. */
export type McpOAuthStateStore = Pick<McpOAuthServerStore, "load" | "save">;

/** pi-mcp's `StdioTransportOptions`. */
export interface StdioTransportOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  stderr?: "pipe" | "inherit";
  onStderr?: (chunk: string) => void;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
  /** Time to wait for the server to exit after SIGTERM before sending SIGKILL. Default: 2000. */
  closeTimeoutMs?: number;
}

/** pi-mcp's `StdioTransport`. */
export interface StdioTransport extends McpTransport {
  readonly options: Readonly<StdioTransportOptions>;
  readonly pid: number | undefined;
  readonly stderr: string;
}

/** pi-mcp's `Tool`, as a server lists it in `tools/list`. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  execution?: { taskSupport?: "forbidden" | "optional" | "required" };
  _meta?: Record<string, unknown>;
}

/** pi-mcp's `ContentAnnotations`. */
export interface McpContentAnnotations {
  audience?: ("user" | "assistant")[];
  priority?: number;
  lastModified?: string;
}

/** pi-mcp's `OAuthChallenge`, parsed from a server's `WWW-Authenticate` header. */
export interface McpOAuthChallenge {
  resourceMetadataUrl?: URL;
  scope?: string;
  error?: string;
  errorDescription?: string;
}

/** The SDK's `McpOAuthSettings`; `clientSecret` is already resolved. */
export interface McpOAuthSettings {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
}

/** The part of pi-mcp's `McpClient` that pi-web reads. */
export interface McpClient {
  readonly connectionState: "idle" | "connecting" | "connected" | "closed";
  readonly serverInfo: { name: string; version: string; title?: string } | undefined;
  readonly instructions: string | undefined;
  readonly protocolVersion: string | undefined;
  close(): Promise<void>;
}

export type McpServerState = "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed";

export interface McpServerConnectionOptions {
  entry: McpServerEntry;
  cwd: string;
  createTransport: McpTransportFactory;
  credentials: McpOAuthCredentialStore;
  /** The current token of a pi provider, for servers with `auth.provider`. */
  providerToken?: (provider: string) => Promise<string | undefined>;
  onTools: (connection: McpServerConnection) => void;
  /** Called when `state`, `error`, or `tools` change. */
  onChange?: (connection: McpServerConnection) => void;
}

/** The part of the SDK's `McpServerConnection` that pi-web uses. */
export interface McpServerConnection {
  readonly entry: McpServerEntry;
  state: McpServerState;
  error: string | undefined;
  tools: McpTool[];
  /** Whether the server offers resources. Since pi 1.2.0 they are listed on demand, never at connect. */
  hasResources: boolean;
  /** Server instructions from `initialize`. */
  instructions: string | undefined;
  /** Last OAuth challenge from the server; sign-in uses its resource metadata URL and scope. */
  challenge: McpOAuthChallenge | undefined;
  readonly name: string;
  readonly timeoutMs: number;
  /** Server URL when the server authenticates with OAuth. */
  readonly oauthUrl: string | undefined;
  /** Resolves `oauth.clientSecret`, which may run a `!command`. */
  oauthSettings(): McpOAuthSettings;
  getClient(): Promise<McpClient>;
  reconnect(): Promise<void>;
  signOut(): Promise<void>;
  close(): Promise<void>;
}

export interface McpSignInPrompt {
  /** Show the authorization URL to the user. */
  showAuthorizationUrl(url: URL): void;
  /**
   * Ask for the redirect URL from the browser address bar. Aborted once the loopback callback
   * arrives. Resolves to `undefined` or an empty string when the user cancels.
   */
  promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export interface McpSignInOptions {
  serverUrl: string;
  store: McpOAuthStateStore;
  settings: McpOAuthSettings;
  challenge?: McpOAuthChallenge;
  prompt: McpSignInPrompt;
}

/** The settings `/mcp` changes; `enabled: true` and `exposure: "codemode"` remove the key. */
export interface McpServerConfigPatch {
  enabled?: boolean;
  exposure?: McpExposure;
}

export interface PiSdkInternals {
  /** Real path of the SDK package the members were loaded from. */
  packageDir: string;
  McpServerConnection: new (options: McpServerConnectionOptions) => McpServerConnection;
  createDefaultTransport: McpTransportFactory;
  /** The class the SDK's `McpServerConnection` recognizes as a stdio transport. */
  StdioTransport: new (options: StdioTransportOptions) => StdioTransport;
  loadMcpConfig: (options: { agentDir: string; cwd: string; projectTrusted: boolean }) => LoadedMcpConfig;
  /** Returns true when an entry with the same name was replaced. */
  addMcpServerConfig: (path: string, name: string, config: McpServerConfig) => boolean;
  updateMcpServerConfig: (path: string, name: string, patch: McpServerConfigPatch) => void;
  /** Returns false when the file does not define the server. */
  removeMcpServerConfig: (path: string, name: string) => boolean;
  /** Returns the config, or an error message. */
  validateMcpServerConfig: (name: string, value: unknown) => McpServerConfig | string;
  getMcpToolExposure: (config: McpServerConfig, toolName: string) => McpExposure;
  signInMcpServer: (options: McpSignInOptions) => Promise<void>;
  /** pi-web always uses the default store, `mcp-auth.json` in the agent directory. */
  McpOAuthCredentialStore: new () => McpOAuthCredentialStore;
  McpSignInCancelledError: new () => Error;
  resolveConfigValueOrThrow: (config: string, description: string, env?: Record<string, string>) => string;
  resolveHeadersOrThrow: (
    headers: Record<string, string> | undefined,
    description: string,
    env?: Record<string, string>,
  ) => Record<string, string> | undefined;
  /** Variables a `${NAME}` / `$NAME` value references; none for a `!command` value. */
  getConfigValueEnvVarNames: (config: string) => string[];
  isCommandConfigValue: (config: string) => boolean;
}

export type PiSdkInternalsResult = ({ ok: true } & PiSdkInternals) | { ok: false; reason: string };

type LoadedModules = Record<SdkModuleName, Record<string, unknown>>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameRealPath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isClass(value: unknown): boolean {
  return typeof value === "function" && /^class[\s{]/.test(Function.prototype.toString.call(value));
}

async function importFile(path: string): Promise<Record<string, unknown>> {
  // Loaded at runtime from the SDK's own files, never bundled: a bundled copy
  // would be a second module instance with its own classes.
  return await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(path).href);
}

/**
 * One of the SDK's own files, loaded *synchronously* and without the package
 * root (TASK-000113). For the few reads that a request needs before the first
 * screen is up and that cannot be made async: the project-trust store, whose
 * status is asked for on every prompt and on the trust request itself, lives in
 * `dist/core/trust-manager.js` — forty kilobytes of the SDK's own code — while
 * the package root it is exported from loads the whole 37 MB graph (~1.4 s of
 * blocked loop). Node's `require(esm)` (22.12+, this package requires 22.19)
 * returns the same module instance a dynamic `import()` would, so the trust
 * store the sessions use and the one this read uses are one class.
 *
 * `createRequire` keeps the module out of the bundle: webpack rewrites a
 * `require("...")` it can see, and a second copy of the class would be a
 * different `instanceof` and a different `trust.json` writer.
 */
export function requireSdkModuleSync<T>(relativePath: string): T {
  const packageDir = resolvedSdkPackageDir(process.cwd());
  // The bundler must not see this call. Next rewrites what it recognises as a
  // CommonJS require — it turned the `createRequire(...)` form into
  // `(void 0)(path)`, which threw at runtime while the module graph looked
  // clean — so the require function is fetched from the enclosing module scope
  // at run time instead. The bundle is CommonJS, so that is Node's own require.
  // eslint-disable-next-line no-eval
  let nodeRequire: (request: string) => T;
  try {
    nodeRequire = eval("require") as (request: string) => T;
  } catch {
    // Only reached outside a CommonJS host (a plain ESM test runner). The
    // bundled server always takes the branch above.
    nodeRequire = createRequire(pathToFileURL(join(packageDir, "package.json"))) as (request: string) => T;
  }
  return nodeRequire(join(packageDir, relativePath));
}

/**
 * pi-mcp is a dependency of the SDK, not of pi-web, so it is resolved from the
 * SDK file that imports it: the copy runtime.js uses, whether npm nested it
 * under the SDK or hoisted it.
 */
function resolveMcpClientEntry(packageDir: string): string {
  return resolvePackageImportEntryFrom(
    MCP_PACKAGE,
    pathToFileURL(join(packageDir, SDK_MODULES.mcpRuntime)).href,
  );
}

function resolvedSdkPackageDir(cwd: string): string {
  // Next.js runs the server with the project as cwd, and resolves externals
  // from its build output inside the project, so both find the same package.
  const manifestPath = findPackageJSON(SDK_PACKAGE, pathToFileURL(join(cwd, "package.json")).href);
  if (!manifestPath) throw new Error(`cannot resolve ${SDK_PACKAGE} from ${cwd}`);
  return realpathSync(join(manifestPath, ".."));
}

async function importSdkModules(packageDir: string): Promise<LoadedModules | string> {
  const paths = Object.fromEntries(
    Object.entries(SDK_MODULES).map(([name, path]) => [name, join(packageDir, path)]),
  ) as Record<SdkModuleName, string>;
  try {
    paths.mcpClient = resolveMcpClientEntry(packageDir);
  } catch (error) {
    return `${MCP_PACKAGE}: ${errorMessage(error)}`;
  }
  const modules = {} as LoadedModules;
  for (const [name, path] of Object.entries(paths) as [SdkModuleName, string][]) {
    try {
      modules[name] = await importFile(path);
    } catch (error) {
      return `cannot load ${path}: ${errorMessage(error)}`;
    }
  }
  return modules;
}

function sdkMembers(modules: LoadedModules): Record<string, unknown> | string {
  const members: Record<string, unknown> = {};
  for (const [name, { module, kind }] of Object.entries(MEMBERS)) {
    const value = modules[module][name];
    if (kind === "class" ? !isClass(value) : typeof value !== "function") {
      const path = module === "mcpClient" ? MCP_PACKAGE : SDK_MODULES[module];
      return `${path} does not export ${name} as a ${kind}`;
    }
    members[name] = value;
  }
  return members;
}

/**
 * McpServerConnection only reads a stdio server's stderr when its transport is
 * an instance of the StdioTransport class runtime.js imported. Constructing a
 * transport spawns nothing.
 */
function sharesStdioTransport(internals: PiSdkInternals): boolean {
  const probe = internals.createDefaultTransport(
    { name: "pi-web-probe", config: { command: "pi-web-probe" }, source: "pi-web" },
    internals.packageDir,
    undefined,
  );
  return probe instanceof internals.StdioTransport;
}

/**
 * Load the SDK internals without caching. `environment` and `cwd` exist for
 * tests; the server uses `loadPiSdkInternals()`.
 */
export async function importPiSdkInternals(options: {
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): Promise<PiSdkInternalsResult> {
  const { environment = process.env, cwd = process.cwd() } = options;
  // PI_PACKAGE_DIR moves getPackageDir() away from the SDK this process
  // loaded, so file URLs would load a second copy.
  if (environment.PI_PACKAGE_DIR) {
    return { ok: false, reason: `PI_PACKAGE_DIR is set; MCP support loads only from the ${SDK_PACKAGE} that Entity Assistant runs` };
  }

  // Imported here, not with the module (TASK-000113): the first screen reaches
  // this file through project-trust's MCP listing, and a static symbol from the
  // SDK root would load the whole graph on that request. Node caches the module,
  // so this is the same instance the session runtime gets.
  //
  // Loaded by file URL with the bundler told to look away (DEFECT-000092), the
  // same form as `importFile` below. The bare specifier this used to be was
  // compiled into webpack's placeholder for an unresolved dynamic import: the
  // package exports `types`/`import` only, with no `require` condition, so the
  // CommonJS server graph judged `import("@earendil-works/pi-coding-agent")`
  // unresolvable and emitted a function that throws `Cannot find module` no
  // matter what is installed — MCP was off in every build that shipped it.
  // The directory comes from this process's cwd (like `requireSdkModuleSync`
  // and nothing from the package's exports), and `scripts/prepare-desktop.mjs`
  // fails the build if such a placeholder ever comes back.
  let packageDir: string;
  try {
    packageDir = resolvedSdkPackageDir(cwd);
  } catch (error) {
    return { ok: false, reason: `cannot locate ${SDK_PACKAGE}: ${errorMessage(error)}` };
  }
  let sdkRoot: Record<string, unknown>;
  try {
    sdkRoot = await importFile(join(packageDir, SDK_ENTRY));
  } catch (error) {
    return { ok: false, reason: `cannot load ${join(packageDir, SDK_ENTRY)}: ${errorMessage(error)}` };
  }
  const createMcpExtension = sdkRoot.createMcpExtension;
  const getPackageDir = sdkRoot.getPackageDir;
  if (typeof createMcpExtension !== "function" || typeof getPackageDir !== "function") {
    return { ok: false, reason: `${join(packageDir, SDK_ENTRY)} does not export createMcpExtension and getPackageDir` };
  }
  try {
    const loadedDir = realpathSync((getPackageDir as () => string)());
    if (!sameRealPath(loadedDir, packageDir)) {
      return { ok: false, reason: `${SDK_PACKAGE} at ${loadedDir} is not the package Entity Assistant resolves (${packageDir})` };
    }
  } catch (error) {
    return { ok: false, reason: `cannot locate ${SDK_PACKAGE}: ${errorMessage(error)}` };
  }

  const modules = await importSdkModules(packageDir);
  if (typeof modules === "string") return { ok: false, reason: modules };
  // The SDK root pi-web imports normally must be the same module instance.
  if (modules.mcpExtension.createMcpExtension !== createMcpExtension) {
    return { ok: false, reason: `${SDK_MODULES.mcpExtension} loaded as a second copy of ${SDK_PACKAGE}` };
  }
  const members = sdkMembers(modules);
  if (typeof members === "string") return { ok: false, reason: members };
  const internals = { packageDir, ...members } as PiSdkInternals;
  try {
    if (!sharesStdioTransport(internals)) {
      return { ok: false, reason: `${MCP_PACKAGE} resolved to another copy than ${SDK_MODULES.mcpRuntime} uses` };
    }
  } catch (error) {
    return { ok: false, reason: `${SDK_MODULES.mcpRuntime}: ${errorMessage(error)}` };
  }
  return { ok: true, ...internals };
}

// Route handlers and instrumentation are bundled into separate module graphs,
// and hot reload re-evaluates this module; globalThis keeps one load per process.
const INTERNALS_KEY: symbol = Symbol.for("pi-web.piSdkInternals");

/**
 * The SDK's unexported MCP modules, loaded once per server process. When this
 * returns `ok: false`, MCP stays off: pi-web never falls back to transports
 * that pass the server's whole environment to MCP servers.
 */
export function loadPiSdkInternals(): Promise<PiSdkInternalsResult> {
  const store = globalThis as Record<symbol, Promise<PiSdkInternalsResult> | undefined>;
  return store[INTERNALS_KEY] ??= importPiSdkInternals().catch((error: unknown): PiSdkInternalsResult => ({
    ok: false,
    reason: errorMessage(error),
  }));
}
