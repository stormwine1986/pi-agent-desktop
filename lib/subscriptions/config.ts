import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
// js-yaml 5 ships named exports only (no default), so import the function.
import { load as loadYaml } from "js-yaml";

/**
 * `subscriptions.yaml` in a workspace directory declares the event sources this
 * workspace listens to. It is read every time a source (re)connects, so editing
 * the file takes effect without restarting the app.
 *
 * The shape is deliberately close to what an entity-events backend expects:
 *
 *   subscriptions:
 *     - name: Entity
 *       url: http://localhost:3000/entity/events/stream
 *       params: { entityTypes: MR,OR, types: entity.created, workspaceId: ws_x }
 *       filter: 'aggregateType == "MR" && payload.toState == "DEFINED"'
 *       action: 新建任务
 */
export type SubscriptionAction = "notify" | "new-task";

export interface SubscriptionSource {
  name: string;
  /** The stream URL with `params` already applied. */
  url: string;
  params: Record<string, string>;
  /** Raw expression text; empty means "accept everything". */
  filter: string;
  action: SubscriptionAction;
  /** Extra instructions prepended to the event payload when a task is started. */
  prompt: string;
  apiKey: string;
  headers: Record<string, string>;
}

export interface SubscriptionConfigFile {
  path: string;
  /** A missing file is not an error: the workspace simply subscribes to nothing. */
  exists: boolean;
  sources: SubscriptionSource[];
  /** Why the file could not be used, in a form the page can show as-is. */
  error: string | null;
}

/**
 * Where the file may live, in the order it is looked up: the workspace root
 * first (most discoverable), then the project's `.pi` directory — the same
 * place `.pi/settings.json`, `.pi/skills` and `.pi/agents` live, for a
 * subscription file that belongs with the rest of a project's tool config.
 */
export const CONFIG_RELATIVE_PATHS = [
  "subscriptions.yaml",
  "subscriptions.yml",
  join(".pi", "subscriptions.yaml"),
  join(".pi", "subscriptions.yml"),
] as const;

const MAX_URL_LENGTH = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `params` values may be written as numbers, booleans, or lists — all become one query value. */
function paramValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(paramValue).filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(",") : null;
  }
  return null;
}

export function normalizeAction(value: unknown): SubscriptionAction {
  if (typeof value !== "string") return "notify";
  const normalized = value.trim().toLowerCase();
  if (normalized === "new-task" || normalized === "newtask" || normalized === "task" || value.trim() === "新建任务") {
    return "new-task";
  }
  return "notify";
}

/** Absolute http(s) only, and never a fragment (it would not reach the server). */
export function normalizeStreamUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "url is required" };
  if (trimmed.length > MAX_URL_LENGTH) return { error: `url must be at most ${MAX_URL_LENGTH} characters` };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `not an absolute URL: ${trimmed}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `url must use http or https: ${trimmed}` };
  }
  if (parsed.hash) return { error: `url must not contain a fragment: ${trimmed}` };
  return { url: parsed.toString() };
}

/** Query parameters apply only when the URL does not already name them. */
export function withParams(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

/**
 * `cid` is the consumer-instance key an event channel uses to kick a stale
 * connection: a new connection with the same `(user, cid)` supersedes the old
 * one. Without it, a runner that restarts (or crashes without a clean FIN) can
 * collect the same window twice.
 *
 * It has to be **stable across restarts** (so the restart supersedes its own
 * zombie) and **distinct per source and workspace** (so two subscriptions never
 * kick each other). Hence a hash of both, never a random id.
 *
 * A `cid` written into the yaml wins — some deployments expect a specific value.
 */
export function subscriptionCid(cwd: string, sourceName: string): string {
  const digest = createHash("sha1").update(`${cwd}|${sourceName}`).digest("hex").slice(0, 16);
  return `pi-agent-${digest}`;
}

export function streamUrlWithCid(url: string, cwd: string, sourceName: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has("cid")) return parsed.toString();
  parsed.searchParams.set("cid", subscriptionCid(cwd, sourceName));
  return parsed.toString();
}

export interface ParsedSource {
  source?: SubscriptionSource;
  error?: string;
}

export function parseSource(raw: unknown, index: number): ParsedSource {
  if (!isRecord(raw)) return { error: `subscriptions[${index}] must be a mapping` };

  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `source-${index + 1}`;
  if (typeof raw.url !== "string") return { error: `${name}: url is required` };
  const normalizedUrl = normalizeStreamUrl(raw.url);
  if ("error" in normalizedUrl) return { error: `${name}: ${normalizedUrl.error}` };

  const params: Record<string, string> = {};
  if (raw.params !== undefined) {
    if (!isRecord(raw.params)) return { error: `${name}: params must be a mapping` };
    for (const [key, value] of Object.entries(raw.params)) {
      const text = paramValue(value);
      if (text !== null && text !== "") params[key] = text;
    }
  }

  if (raw.filter !== undefined && raw.filter !== null && typeof raw.filter !== "string") {
    return { error: `${name}: filter must be a string expression` };
  }
  if (raw.prompt !== undefined && raw.prompt !== null && typeof raw.prompt !== "string") {
    return { error: `${name}: prompt must be a string` };
  }

  const headers: Record<string, string> = {};
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) return { error: `${name}: headers must be a mapping` };
    for (const [key, value] of Object.entries(raw.headers)) {
      const text = paramValue(value);
      if (text !== null) headers[key] = text;
    }
  }

  // An inline key is convenient for a local backend; `apiKeyEnv` keeps secrets
  // out of a file that may be committed.
  let apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (!apiKey && typeof raw.apiKeyEnv === "string" && raw.apiKeyEnv.trim()) {
    apiKey = process.env[raw.apiKeyEnv.trim()] ?? "";
  }

  return {
    source: {
      name,
      url: withParams(normalizedUrl.url, params),
      params,
      filter: typeof raw.filter === "string" ? raw.filter.trim() : "",
      action: normalizeAction(raw.action),
      prompt: typeof raw.prompt === "string" ? raw.prompt.trim() : "",
      apiKey,
      headers,
    },
  };
}

export function parseSubscriptionsYaml(text: string): { sources: SubscriptionSource[]; error: string | null } {
  // js-yaml rejects an empty document; an all-comment file is not a mistake.
  if (!text.trim()) return { sources: [], error: null };
  let document: unknown;
  try {
    document = loadYaml(text);
  } catch (error) {
    return { sources: [], error: `YAML 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (document === null || document === undefined) return { sources: [], error: null };
  if (!isRecord(document)) return { sources: [], error: "顶层必须是映射，包含 subscriptions 列表" };

  // A single source without the list is accepted: one-line configs stay one line.
  const list = Array.isArray(document.subscriptions)
    ? document.subscriptions
    : isRecord(document.subscription)
      ? [document.subscription]
      : null;
  if (list === null) return { sources: [], error: "缺少 subscriptions 列表" };

  const sources: SubscriptionSource[] = [];
  const errors: string[] = [];
  list.forEach((entry, index) => {
    const parsed = parseSource(entry, index);
    if (parsed.source) sources.push(parsed.source);
    else if (parsed.error) errors.push(parsed.error);
  });
  return { sources, error: errors.length > 0 ? errors.join("；") : null };
}

export function configPathFor(cwd: string): string {
  for (const relative of CONFIG_RELATIVE_PATHS) {
    const candidate = join(cwd, relative);
    if (existsSync(candidate)) return candidate;
  }
  return join(cwd, CONFIG_RELATIVE_PATHS[0]);
}

export function readSubscriptionConfig(cwd: string): SubscriptionConfigFile {
  const path = configPathFor(cwd);
  if (!existsSync(path)) return { path, exists: false, sources: [], error: null };
  try {
    const parsed = parseSubscriptionsYaml(readFileSync(path, "utf8"));
    return { path, exists: true, sources: parsed.sources, error: parsed.error };
  } catch (error) {
    return {
      path,
      exists: true,
      sources: [],
      error: `读取失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
