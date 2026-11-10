import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpServerKey } from "./mcp-server-name";

/**
 * Calls a tool on a configured MCP server over streamable HTTP.
 *
 * Nothing in this app could do that before: `lib/mcp-host.ts` only decides
 * which servers a *session* connects, and `app/api/mcp` only edits the config.
 * The to-do view needs a tool result without a conversation, so this reads
 * `mcp.json` and speaks JSON-RPC directly.
 *
 * Scope, deliberately narrow:
 * - **HTTP transports only.** A `command`/`args` entry would mean spawning a
 *   process out of a repository file; that is refused rather than implemented.
 * - **No `!command` values.** The SDK allows a config value to be produced by
 *   running a shell command. Running those from a web request would turn a
 *   project file into code execution, so such a value is an error here.
 * - `${VAR}` is expanded from the server's own environment, which is how the
 *   app stores tokens (the literal never lands in `mcp.json`).
 */

export interface McpHttpTarget {
  name: string;
  url: string;
  headers: Record<string, string>;
  /** Which file defined the entry, for error messages. */
  source: string;
  /**
   * Digest of the entry as configured (`source`, name, url, headers). A change of
   * any of them is a different connection to this app, so a cached environment
   * identity (`readServerIdentity`) must not survive it — that is the
   * "配置变更即失效" half of ENV-RESOLVE ②.
   */
  fingerprint: string;
  /**
   * Optional deployment pin: `instanceId` written on the entry, e.g.
   * `{ "url": "…", "instanceId": "ins_demo" }`. It is the only comparator for
   * "is this the environment this project means" that does not come from the
   * request (ENV-RESOLVE ④, SSR-000091 AC-6): a link's id only says which one
   * the writer wanted, never what is true.
   */
  pinnedInstanceId?: string;
}

export type McpTargetResult = { ok: true; target: McpHttpTarget } | { ok: false; error: string };

export type McpToolResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: string;
      /**
       * The server's typed error body when it sent one (`code`, `statusCode`,
       * `retriable`, `skippedByPolicy`, `details`). Entity-base puts the contract
       * there, so callers that must tell a business refusal from a real fault
       * read these fields instead of guessing from the message.
       */
      structured?: Record<string, unknown>;
    };

const CONFIG_FILENAME = "mcp.json";
const PROJECT_CONFIG_RELATIVE = join(".pi", CONFIG_FILENAME);
const DEFAULT_TIMEOUT_MS = 8_000;
const PROTOCOL_VERSION = "2025-06-18";

/** `${NAME}` → the server's environment. A missing variable is an error, not an empty string. */
function expand(value: string): { ok: true; text: string } | { ok: false; error: string } {
  if (value.startsWith("!")) {
    return { ok: false, error: "配置值是 !command，本功能不执行命令（安全起见）" };
  }
  let missing: string | null = null;
  const text = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      missing ??= name;
      return "";
    }
    return resolved;
  });
  if (missing) return { ok: false, error: `环境变量 ${missing} 没有设置` };
  return { ok: true, text };
}

function readConfigFile(path: string): { entries: Record<string, unknown>; path: string } | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== "object" || servers === null) return null;
    return { entries: servers as Record<string, unknown>, path };
  } catch {
    return null;
  }
}

/**
 * Finds the entry `serverName` in the global `mcp.json` and the project's
 * `.pi/mcp.json` — the same two files the app writes. A project entry replaces
 * the global one of its name, as the SDK loads it.
 *
 * An exact name wins; otherwise the configured name whose pi namespace matches
 * is taken (`entity_demo_system_evan` → `entity-demo-system-evan`, see
 * `lib/mcp-server-name.ts`). pi refuses two loaded servers sharing a namespace,
 * so that fallback is unambiguous — and if the files do it anyway, the first
 * configured spelling wins.
 */
export function resolveMcpTarget(agentDir: string, cwd: string, serverName: string): McpTargetResult {
  const global = readConfigFile(join(agentDir, CONFIG_FILENAME));
  const project = readConfigFile(join(cwd, PROJECT_CONFIG_RELATIVE));

  const lookup = (entries: Record<string, unknown> | undefined): { name?: string; entry?: unknown } => {
    if (entries === undefined) return {};
    if (entries[serverName] !== undefined) return { name: serverName, entry: entries[serverName] };
    const wanted = mcpServerKey(serverName);
    const name = Object.keys(entries).find((candidate) => mcpServerKey(candidate) === wanted);
    return name === undefined ? {} : { name, entry: entries[name] };
  };

  const fromProject = lookup(project?.entries);
  const hit = fromProject.entry !== undefined ? fromProject : lookup(global?.entries);
  const entry = hit.entry;
  const source = (fromProject.entry !== undefined ? project?.path : global?.path) ?? join(agentDir, CONFIG_FILENAME);
  // The configured spelling, so callers that echo it back name the real entry.
  const name = hit.name ?? serverName;

  if (entry === undefined) {
    const known = [
      ...Object.keys(global?.entries ?? {}),
      ...Object.keys(project?.entries ?? {}),
    ].filter((name, index, all) => all.indexOf(name) === index);
    const hint = known.length > 0 ? `（已配置：${known.join("、")}）` : "（还没有配置任何 MCP server）";
    return { ok: false, error: `mcp.json 里没有名为 "${serverName}" 的 server${hint}` };
  }

  if (typeof entry !== "object" || entry === null) {
    return { ok: false, error: `server "${name}" 的配置不是对象` };
  }

  const raw = entry as Record<string, unknown>;
  if (typeof raw.command === "string") {
    return { ok: false, error: `server "${name}" 是 stdio 类型（command），本功能只支持 HTTP 端点` };
  }

  const urlText = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!urlText) return { ok: false, error: `server "${name}" 没有 url` };
  const expanded = expand(urlText);
  if (!expanded.ok) return { ok: false, error: `server "${name}" 的 url ${expanded.error}` };

  let url: URL;
  try {
    url = new URL(expanded.text);
  } catch {
    return { ok: false, error: `server "${name}" 的 url 不是合法地址：${expanded.text}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `server "${name}" 的 url 必须是 http(s)` };
  }

  const pinnedInstanceId = typeof raw.instanceId === "string" && raw.instanceId.trim()
    ? raw.instanceId.trim()
    : undefined;

  const headers: Record<string, string> = {};
  const rawHeaders = raw.headers;
  if (rawHeaders !== undefined) {
    if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
      return { ok: false, error: `server "${name}" 的 headers 不是对象` };
    }
    for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof value !== "string") {
        return { ok: false, error: `server "${name}" 的 header "${key}" 不是字符串` };
      }
      const headerValue = expand(value);
      if (!headerValue.ok) return { ok: false, error: `server "${name}" 的 header "${key}" ${headerValue.error}` };
      headers[key] = headerValue.text;
    }
  }

  const fingerprint = createHash("sha256")
    .update(JSON.stringify([source, name, url.toString(), headers]))
    .digest("hex")
    .slice(0, 32);

  return {
    ok: true,
    target: {
      name,
      url: url.toString(),
      headers,
      source,
      fingerprint,
      ...(pinnedInstanceId ? { pinnedInstanceId } : {}),
    },
  };
}

/**
 * What the connection has learned about the environment, per session so repeat
 * reads skip the handshake, and per `(cwd, server)` so a resolved link costs one
 * read instead of one probe per configured entry (ENV-RESOLVE AC-6).
 */
export interface McpServerIdentityReading {
  /** The `initialize` result's `serverInfo`, verbatim; null when unavailable. */
  serverInfo: Record<string, unknown> | null;
  /** Whether the value came from a live session (freshest) or the cache. */
  fromSession: boolean;
}

/** Session ids by server, so repeat refreshes skip the handshake. */
const sessions = new Map<string, { id: string; serverInfo: Record<string, unknown> | null }>();

interface IdentityCacheEntry {
  fingerprint: string;
  serverInfo: Record<string, unknown> | null;
}

/**
 * `(cwd, server) → 声明的身份`, on `globalThis` for the same reason the session
 * registry is: a route module can be instantiated twice, and an identity that
 * vanished on reload would be re-handshaked for every read.
 */
const identityCacheSymbol = Symbol.for("pi-web:mcp-identity");
const identityCache: Map<string, IdentityCacheEntry> = (() => {
  const holder = globalThis as Record<symbol, unknown>;
  const existing = holder[identityCacheSymbol];
  if (existing instanceof Map) return existing as Map<string, IdentityCacheEntry>;
  const fresh = new Map<string, IdentityCacheEntry>();
  holder[identityCacheSymbol] = fresh;
  return fresh;
})();

/** Test seam: forget everything a fixture taught this process. */
export function resetMcpIdentityCache(): void {
  identityCache.clear();
  sessions.clear();
}

function sessionKey(target: McpHttpTarget): string {
  return `${target.url}\u0000${JSON.stringify(target.headers)}`;
}

interface RpcOutcome {
  result?: unknown;
  error?: string;
  sessionId?: string | null;
}

/** Reads one JSON-RPC response from a body that may be JSON or an SSE stream. */
async function readRpcResponse(response: Response, id: number): Promise<RpcOutcome> {
  const sessionId = response.headers.get("mcp-session-id");
  if (response.status === 202) return { sessionId };

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (!text.trim()) {
    return { error: `服务端返回空响应（HTTP ${response.status}）`, sessionId };
  }

  const candidates: string[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
    }
  } else {
    candidates.push(text);
  }

  for (const candidate of candidates) {
    if (!candidate || candidate === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const message = parsed as { id?: unknown; result?: unknown; error?: { message?: unknown } };
    if (message.id !== undefined && message.id !== id) continue;
    if (message.error) {
      const detail = typeof message.error.message === "string" ? message.error.message : JSON.stringify(message.error);
      return { error: detail, sessionId };
    }
    if (message.result !== undefined) return { result: message.result, sessionId };
  }

  return { error: `响应里没有匹配 id=${id} 的 JSON-RPC 结果（HTTP ${response.status}）`, sessionId };
}

async function rpc(
  target: McpHttpTarget,
  body: Record<string, unknown>,
  id: number,
  signal: AbortSignal,
): Promise<RpcOutcome & { status: number }> {
  const sessionId = sessions.get(sessionKey(target))?.id;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...target.headers,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };

  let response: Response;
  try {
    response = await fetch(target.url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `连不上 ${target.name}：${message}`, status: 0 };
  }

  if (response.status === 401 || response.status === 403) {
    return { error: `${target.name} 拒绝访问（HTTP ${response.status}），检查 mcp.json 里的 Authorization`, status: response.status };
  }
  if (response.status >= 400 && response.status !== 202) {
    const text = await response.text().catch(() => "");
    return { error: `${target.name} 返回 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ""}`, status: response.status };
  }

  const outcome = await readRpcResponse(response, id);
  return { ...outcome, status: response.status };
}

/**
 * Calls `toolName` on the server and returns its `structuredContent` (or the
 * single text content when the server answers with text). The caller decides
 * what to do with an unfamiliar shape.
 */
export async function callMcpTool(
  target: McpHttpTarget,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<McpToolResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  const key = sessionKey(target);
  const existing = sessions.get(key);

  const callTool = async (id: number) => {
    const outcome = await rpc(
      target,
      { jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName, arguments: args } },
      id,
      signal,
    );
    const result = outcome.result as { isError?: unknown; structuredContent?: unknown; content?: unknown } | undefined;
    if (result?.isError === true) {
      const structured =
        typeof result.structuredContent === "object" && result.structuredContent !== null
          ? (result.structuredContent as Record<string, unknown>)
          : undefined;
      return {
        ok: false as const,
        error: toolErrorText(result.content) ?? `${toolName} 返回 isError`,
        ...(structured ? { structured } : {}),
      };
    }
    if (result?.structuredContent !== undefined) return { ok: true as const, value: result.structuredContent };
    const text = toolErrorText(result?.content);
    if (text !== null) {
      try {
        return { ok: true as const, value: JSON.parse(text) };
      } catch {
        return { ok: false as const, error: `${toolName} 返回了非 JSON 文本：${text.slice(0, 200)}` };
      }
    }
    return { ok: false as const, error: `${toolName} 没有返回内容` };
  };

  if (existing) {
    const direct = await callTool(1);
    if (direct.ok || !isSessionExpired(direct.error)) return direct;
    sessions.delete(key);
  }

  const init = await initializeSession(target, signal);
  if (!init.ok) return { ok: false, error: init.error };

  return callTool(1);
}

/** One `initialize`, remembered with its session and its declared identity. */
async function initializeSession(
  target: McpHttpTarget,
  signal: AbortSignal,
): Promise<{ ok: true; serverInfo: Record<string, unknown> | null } | { ok: false; error: string }> {
  const key = sessionKey(target);
  const init = await rpc(
    target,
    {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "pi-agent-desktop", version: "0.8.2" },
      },
    },
    0,
    signal,
  );
  if (init.error) return { ok: false, error: init.error };
  const result = init.result as { serverInfo?: unknown } | undefined;
  const serverInfo = typeof result?.serverInfo === "object" && result.serverInfo !== null
    ? result.serverInfo as Record<string, unknown>
    : null;
  if (init.sessionId) sessions.set(key, { id: init.sessionId, serverInfo });

  // Notification: no id, no response expected — failures here are not fatal.
  await fetch(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...target.headers,
      ...(init.sessionId ? { "mcp-session-id": init.sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal,
  }).catch(() => undefined);

  return { ok: true, serverInfo };
}

/**
 * The environment identity this connection declares (ENV-RESOLVE ②).
 *
 * The primary source is `initialize.serverInfo._meta.instanceId`: it arrives with
 * the handshake, once per connection, before any tool call. A live session owns
 * the newest reading — a reconnect after a redeploy replaces it, so the value is
 * not frozen at process start. Only when no session is live does the
 * `(cwd, server)` cache answer, and only while the config still hashes to the
 * same fingerprint; a changed entry is a different connection and re-handshakes.
 *
 * This never calls `about_me` or `/version`: they are the per-session secondary
 * and the ops/HTTP surface respectively, and making them the decision source is
 * explicitly out of bounds (答复 evan 2026-11-09 ④).
 */
export async function readServerIdentity(
  target: McpHttpTarget,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: true; reading: McpServerIdentityReading } | { ok: false; error: string }> {
  const cacheKey = `${cwd}\u0000${target.name}`;
  const live = sessions.get(sessionKey(target));
  if (live) {
    identityCache.set(cacheKey, { fingerprint: target.fingerprint, serverInfo: live.serverInfo });
    return { ok: true, reading: { serverInfo: live.serverInfo, fromSession: true } };
  }

  const cached = identityCache.get(cacheKey);
  if (cached && cached.fingerprint === target.fingerprint) {
    return { ok: true, reading: { serverInfo: cached.serverInfo, fromSession: false } };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const init = await initializeSession(target, signal);
  if (!init.ok) return { ok: false, error: init.error };
  identityCache.set(cacheKey, { fingerprint: target.fingerprint, serverInfo: init.serverInfo });
  return { ok: true, reading: { serverInfo: init.serverInfo, fromSession: true } };
}

function isSessionExpired(error: string | undefined): boolean {
  return typeof error === "string" && /session|404/i.test(error);
}

function toolErrorText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
