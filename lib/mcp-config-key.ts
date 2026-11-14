import { createHmac, randomBytes } from "node:crypto";

// How an `mcp.json` entry is identified across the modules that compare
// entries: the MCP host (`lib/mcp-host.ts`) diffs what it registered against
// the files, and Settings › MCP (`lib/mcp-config-read.ts`) lists entries with
// the key their last known status (`lib/mcp-status.ts`) was recorded under.
// The host writes those statuses too, and `mcp-config-read` already imports
// the host's module chain, so both live here rather than in either of them.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How deep `canonicalJson()` follows arrays and objects. Real entries are a
 * few levels deep; the entries hashed include an untrusted repository's
 * `.pi/mcp.json`, which `JSON.parse` accepts hundreds of thousands of levels
 * deep, and one recursion per level would overflow the stack at a few
 * thousand.
 */
export const MCP_CONFIG_KEY_MAX_DEPTH = 64;

/** What stands for an array or object below the depth limit: not JSON, so no value prints as it. */
const TOO_DEEP = "<too deep>";

/**
 * The same marker as a value: a `Map`, which no JSON an entry can hold is, and
 * which structured clone carries across a worker boundary undamaged. See
 * `truncateConfigValue()`.
 */
const TOO_DEEP_VALUE = new Map<unknown, unknown>();

/**
 * JSON with sorted keys, so an entry compares equal however its file orders it.
 * Total: past `MCP_CONFIG_KEY_MAX_DEPTH` levels an array or object prints as a
 * fixed marker instead of being followed. The result only has to be the same
 * for the same value, so two entries that differ only that deep compare equal.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  // `truncateConfigValue()`'s marker: prints what the untruncated value prints
  // at that depth, so a truncated entry hashes to the entry's own key.
  if (value === TOO_DEEP_VALUE) return TOO_DEEP;
  if (Array.isArray(value) || isRecord(value)) {
    if (depth >= MCP_CONFIG_KEY_MAX_DEPTH) return TOO_DEEP;
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A copy of a parsed entry whose arrays and objects stop at
 * `MCP_CONFIG_KEY_MAX_DEPTH`, where `canonicalJson()` stops following them too.
 * Iterative, and the copy is what may cross a thread boundary: structured clone
 * recurses once per level, and an untrusted repository's `.pi/mcp.json` can nest
 * thousands deep — TASK-000277 hit that with `lib/mcp-host.test.mjs`'s
 * 5,000-level fixture, where the worker request itself overflowed the stack.
 * Nothing the listing shows lives that deep: an entry is described by its known
 * fields, and the marker prints as what the untruncated value prints there, so
 * `configKey` is the key the same entry has without the truncation. One
 * consequence to know, confined to entries deeper than the cap: the SDK's
 * validator is shown the marker where its input was, so a known field nested
 * that deep is judged as an object that is not one, not as its real shape.
 */
export function truncateConfigValue(value: unknown, maxDepth: number = MCP_CONFIG_KEY_MAX_DEPTH): unknown {
  if (!Array.isArray(value) && !isRecord(value)) return value;
  const root: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
  const pending: { source: unknown[] | Record<string, unknown>; target: unknown[] | Record<string, unknown>; depth: number }[] = [
    { source: value, target: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const { source, target, depth } = pending.pop() as (typeof pending)[number];
    const pairs: [string | number, unknown][] = Array.isArray(source)
      ? source.map((item, index) => [index, item] as [number, unknown])
      : Object.entries(source);
    for (const [key, item] of pairs) {
      const set = (assigned: unknown) => {
        (target as Record<string | number, unknown>)[key] = assigned;
      };
      if (!Array.isArray(item) && !isRecord(item)) {
        set(item);
        continue;
      }
      if (depth + 1 >= maxDepth) {
        set(TOO_DEEP_VALUE);
        continue;
      }
      const next: unknown[] | Record<string, unknown> = Array.isArray(item) ? [] : {};
      set(next);
      pending.push({ source: item, target: next, depth: depth + 1 });
    }
  }
  return root;
}

// One key per server process: hot reload re-evaluates this module, globalThis keeps it.
const CONFIG_KEY_SECRET: symbol = Symbol.for("pi-web:mcp-config-key-secret");

/**
 * What identifies an entry's content, so a status recorded for it can be
 * dropped once the entry changes: an HMAC of its canonical JSON (sorted keys)
 * under a key this process picked at random. Never the JSON itself, which
 * would carry every literal env and header value to the browser, and not a
 * plain hash either, which a weak password in an otherwise visible entry
 * would not survive. Stable for the life of the process, like the statuses
 * it is compared with.
 */
export function mcpConfigKey(value: unknown): string {
  const store = globalThis as Record<symbol, Buffer | undefined>;
  const secret = (store[CONFIG_KEY_SECRET] ??= randomBytes(32));
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("base64url");
}

/**
 * The key of an `mcp.json` entry as pi loads it: the validator's copy when it
 * accepts the entry (`validated`, the return of `validateMcpServerConfig()`),
 * else the entry as written. The copy has the exposure aliases resolved
 * (`codemode-deferred` reads `codemode`), and it is what `loadMcpConfig()`
 * hands the MCP host, so the host and Settings key an entry alike.
 */
export function mcpEntryConfigKey(value: unknown, validated: unknown): string {
  return mcpConfigKey(isRecord(validated) ? validated : value);
}
