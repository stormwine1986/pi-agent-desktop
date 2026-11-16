import { callMcpTool, type McpHttpTarget } from "../mcp-call";

/**
 * One `get_metadata` read per endpoint + space + type, shared by everything that
 * needs the type's schema.
 *
 * Two readers already want the same document: the panel's `orderBy` validation
 * (which only needs `fields[].name`) and the pump (which needs the routes and
 * their `requiredFields` before it parks an item). They are not cached apart —
 * a dozen views over one type must not become a dozen metadata reads per
 * refresh, and a second cache with a different lifetime would just drift.
 *
 * A failure is remembered for a shorter while, so a server that is briefly down
 * does not cost a request per view per refresh. Both TTLs are the ones the
 * `orderBy` check shipped with.
 */
const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

export type TypeMetadataResult = { ok: true; value: unknown } | { ok: false; error: string };

interface CacheEntry {
  result: TypeMetadataResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** The cache key: a different endpoint, space, type or credential is a different document. */
function keyOf(target: McpHttpTarget, workspace: string, type: string): string {
  return `${target.url}\u0000${target.fingerprint}\u0000${workspace}\u0000${type}`;
}

/** The type's `get_metadata` document, remembered for a few minutes. */
export async function readTypeMetadata(
  target: McpHttpTarget,
  workspace: string,
  type: string,
): Promise<TypeMetadataResult> {
  const key = keyOf(target, workspace, type);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  const called = await callMcpTool(target, "get_metadata", { type });
  const result: TypeMetadataResult = called.ok ? { ok: true, value: called.value } : { ok: false, error: called.error };
  cache.set(key, {
    result,
    expiresAt: now + (result.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
  });
  return result;
}

/** For tests: forget everything, so a stub server can answer differently next time. */
export function resetTypeMetadataCache(): void {
  cache.clear();
}
