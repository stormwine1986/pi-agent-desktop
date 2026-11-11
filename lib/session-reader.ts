import { SessionManager } from "@earendil-works/pi-coding-agent";

import { statSync } from "fs";
import type { SessionEntry } from "./types";
import { sessionPathKey } from "./session-path";
import { projectToolResultDetails } from "./tool-result-details";
import { openSlimSessionManager } from "./session-slim-load";

/**
 * Session files: opening one, reading its entries, building a context.
 *
 * This module needs the pi SDK's `SessionManager`, so importing it loads the
 * whole server-external SDK graph. The catalogue half that the first screen
 * asks for (`listSessionSummaries`, `listAllSessions`, path lookups) lives in
 * `lib/session-list.ts`, which must stay SDK-free; it is re-exported here so
 * every existing importer keeps its one-stop import (TASK-000110).
 */
export * from "./session-list";

// ---------------------------------------------------------------------------
// Read-only SessionManager cache.
//
// Opening a large session (SessionManager.open -> full JSONL parse + index
// build) costs 150ms for a small session and ~1.1s for an 82MB one. Detail/
// context/pagination routes re-open the same file on every request whenever no
// live runtime wrapper exists, so a fingerprint-validated cache turns repeat
// opens into ~1ms map hits.
//
// Budget: a count cap alone is not enough. Parsed entries retain roughly the
// file's own size in heap (measured: an 82MB session holds ~94MB), so twelve
// large sessions would pin ~1.1GB. Entries are therefore also capped by the
// summed on-disk size of the cached files, and a single session larger than
// SM_CACHE_LIMITS.maxFileBytes is served fresh instead of being cached — one
// oversize session must not evict every useful entry.
//
// Safety: cached managers are READ-ONLY views. Any write path must go through
// a live wrapper or SessionManager.open directly — call openSessionManager
// with { mutable: true } (bypasses the cache) for those. The fingerprint
// (size + mtimeMs) invalidates on external appends (TUI writes), and
// invalidateSessionManagerCache(filePath) is called on delete/rename.
// ---------------------------------------------------------------------------

interface SmCacheEntry {
  sm: unknown;
  fingerprint: string;
  /** On-disk size, the proxy for this entry's retained heap. */
  bytes: number;
}

declare global {
  var __piSmCache: Map<string, SmCacheEntry> | undefined;
}

/**
 * Cache budget. Exported so tests can shrink it to values they can actually
 * produce on disk; production never reassigns these.
 */
export const SM_CACHE_LIMITS = {
  /** Most sessions held at once. */
  maxEntries: 12,
  /** Summed on-disk size of cached sessions. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** A session larger than this is never cached — it would evict everything else. */
  maxFileBytes: 64 * 1024 * 1024,
};

function getSmCache(): Map<string, SmCacheEntry> {
  if (!globalThis.__piSmCache) globalThis.__piSmCache = new Map();
  return globalThis.__piSmCache;
}

function sessionFileStats(filePath: string): { fingerprint: string; bytes: number } | null {
  try {
    const stats = statSync(filePath);
    return { fingerprint: `${stats.size}:${stats.mtimeMs}`, bytes: stats.size };
  } catch {
    return null;
  }
}

/** Evict least-recently-used entries until both the count and byte caps hold. */
function evictSmCache(cache: Map<string, SmCacheEntry>): void {
  let total = 0;
  for (const entry of cache.values()) total += entry.bytes;
  while (cache.size > SM_CACHE_LIMITS.maxEntries || total > SM_CACHE_LIMITS.maxTotalBytes) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    total -= cache.get(oldestKey)?.bytes ?? 0;
    cache.delete(oldestKey);
  }
}

/**
 * Project every tool result's details in place (see lib/tool-result-details.ts).
 * Mutating is safe only because the manager is a cached read-only view whose
 * entries are never written back. Returns whether anything was dropped.
 */
function slimCachedEntries(sm: SessionManager): boolean {
  let slimmed = false;
  for (const entry of sm.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as { role?: unknown; details?: unknown };
    if (message.role !== "toolResult" || message.details === undefined) continue;
    const projected = projectToolResultDetails(message.details);
    if (projected === message.details) continue;
    if (projected === undefined) delete message.details;
    else message.details = projected;
    slimmed = true;
  }
  return slimmed;
}

/** Retained size after slimming: the file size is no longer a fair proxy. */
function estimateRetainedBytes(sm: SessionManager, fileBytes: number): number {
  try {
    let bytes = 0;
    for (const entry of sm.getEntries()) bytes += JSON.stringify(entry).length;
    return Math.min(bytes, fileBytes);
  } catch {
    return fileBytes;
  }
}

export function invalidateSessionManagerCache(filePath?: string): void {
  const cache = getSmCache();
  if (filePath === undefined) {
    cache.clear();
    return;
  }
  cache.delete(sessionPathKey(filePath));
}

/**
 * Open a session file, reusing a cached read-only SessionManager when the
 * on-disk fingerprint is unchanged. Pass { mutable: true } when the caller
 * intends to append/branch/rewrite — that path always opens fresh.
 */
export function openSessionManager(
  filePath: string,
  options: { mutable?: boolean } = {},
): SessionManager {
  if (options.mutable) return SessionManager.open(filePath, undefined);

  const cache = getSmCache();
  const pathKey = sessionPathKey(filePath);
  const stats = sessionFileStats(filePath);
  if (stats === null) {
    cache.delete(pathKey);
    return SessionManager.open(filePath, undefined);
  }

  const cached = cache.get(pathKey);
  if (cached && cached.fingerprint === stats.fingerprint) {
    // LRU touch.
    cache.delete(pathKey);
    cache.set(pathKey, cached);
    return cached.sm as SessionManager;
  }

  const sm = openSlimSessionManager(filePath) ?? SessionManager.open(filePath, undefined);
  // Cached managers are read-only views, and nothing reads a cached entry's
  // tool-result details beyond what the UI renders, so drop the rest before
  // the entry is retained. Extension payloads (browser DOM outlines) can be
  // 97% of a file; without this a 140MB session was never cacheable and paid
  // a full re-parse on every open.
  const bytes = slimCachedEntries(sm) ? estimateRetainedBytes(sm, stats.bytes) : stats.bytes;
  if (bytes > SM_CACHE_LIMITS.maxFileBytes) {
    // Too large to hold: drop any stale entry for this path and serve fresh.
    cache.delete(pathKey);
    return sm;
  }
  cache.set(pathKey, { sm, fingerprint: stats.fingerprint, bytes });
  evictSmCache(cache);
  return sm;
}
export function getSessionEntries(filePath: string): SessionEntry[] {
  const entries = openSessionManager(filePath).getEntries();
  return entries as unknown as SessionEntry[];
}

// The entry-to-UI projection lives in ./session-context, which must stay
// SDK-free (the first screen's session request needs it without loading the
// SDK). Re-exported so existing importers keep their one-stop import.
export {
  buildSessionContext,
  getLatestModelChange,
  getLatestResponseModel,
  sliceActiveBranch,
  type BuildSessionContextOptions,
} from "./session-context";
