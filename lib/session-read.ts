import { readFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

import { sessionPathKey } from "./session-path";
import { loadSlimSessionEntries, SLIM_LOAD_MAX_FILE_BYTES, SLIM_LOAD_MIN_FILE_BYTES } from "./session-slim-entries";
import type { SessionEntry, SessionHeader } from "./types";

/**
 * Read one session file without the pi SDK (TASK-000113).
 *
 * `GET /api/sessions/[id]` is what the first screen of a cold start waits for
 * when it restores a chat (`hooks/useAgentSession.ts` clears its loading state
 * with that response), and the desktop shell keeps the window hidden until then.
 * `SessionManager.open()` — the obvious way to read the file — imports the SDK's
 * package root, a 37 MB server-external graph that blocks the loop for ~1.4 s.
 * Merging that cost away from one request only moved it to the next one
 * (TASK-000108, TASK-000110), so the read path itself no longer opens a
 * manager: a session file is JSONL, and everything the routes project from it
 * (entries, leaf, tree, name, header) is derived here from the entries alone.
 *
 * `SessionManager` keeps every *mutable or active* path: writing, branching,
 * appending, and the live wrapper's own manager. This module only ever reads.
 *
 * Semantics are the SDK's, deliberately one for one (`SessionManager._buildIndex`
 * / `getTree` / `getSessionName` / `getHeader`), because the client renders the
 * difference: `lib/session-read.test.mjs` compares every field with
 * `SessionManager.open()` on the same files. Two deliberate differences:
 *
 *  - nothing is written. The SDK appends a trailing newline to a file whose last
 *    line is torn, and rewrites a session older than its current format
 *    version; a read must not. A non-current version therefore answers
 *    `needsSessionManager: true` and the route falls back to the SDK once, so an
 *    old file keeps behaving exactly as it did.
 *  - the parse is the slim one for oversized tool-result details (see
 *    `./session-slim-entries`), the same entries the read-only manager cache has
 *    been serving since the 129 MB session.
 */

/** The entry as it appears in the client's tree/summary responses. */
export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label: string | undefined;
  labelTimestamp: string | undefined;
}

export interface SessionFileView {
  /** Resolved path the view was read from. */
  filePath: string;
  /** The `session` header line, or null when the first line is not one. */
  header: SessionHeader | null;
  /** Every entry except the header, in file order. */
  entries: SessionEntry[];
  /** The entry appends branch from: the last entry on disk, labels included. */
  leafId: string | null;
  tree: SessionTreeNode[];
  sessionName: string | undefined;
  /** On-disk bytes this view was parsed from. */
  bytes: number;
  /**
   * Set when the file must be read by the SDK instead: the header names a
   * session format older than the one this reader understands.
   */
  needsSessionManager: boolean;
}

/** The session format this reader understands; older files fall back to the SDK. */
export const CURRENT_SESSION_VERSION = 3;

/**
 * Cache budget, kept in step with the manager cache in `lib/session-reader.ts`.
 * Parsed entries retain roughly the file's own size in heap, so a count cap
 * alone is not a budget. Exported so tests can shrink it.
 */
export const SESSION_READ_CACHE_LIMITS = {
  maxEntries: 12,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
};

interface CacheEntry {
  view: SessionFileView;
  fingerprint: string;
}

declare global {
  var __piSessionReadCache: Map<string, CacheEntry> | undefined;
}

function cache(): Map<string, CacheEntry> {
  if (!globalThis.__piSessionReadCache) globalThis.__piSessionReadCache = new Map();
  return globalThis.__piSessionReadCache;
}

export function invalidateSessionReadCache(filePath?: string): void {
  const views = cache();
  if (filePath === undefined) {
    views.clear();
    return;
  }
  views.delete(sessionPathKey(filePath));
}

function fingerprintOf(filePath: string): { fingerprint: string; bytes: number } | null {
  try {
    const stats = statSync(filePath);
    return { fingerprint: `${stats.size}:${stats.mtimeMs}`, bytes: stats.size };
  } catch {
    return null;
  }
}

function evict(views: Map<string, CacheEntry>): void {
  let total = 0;
  for (const entry of views.values()) total += entry.view.bytes;
  while (views.size > SESSION_READ_CACHE_LIMITS.maxEntries || total > SESSION_READ_CACHE_LIMITS.maxTotalBytes) {
    const oldestKey = views.keys().next().value;
    if (oldestKey === undefined) break;
    total -= views.get(oldestKey)?.view.bytes ?? 0;
    views.delete(oldestKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Entries of the file, header first, parsed as `SessionManager.loadEntriesFromFile`
 * parses them: a malformed line is skipped, a torn last line is dropped, and a
 * BOM (which `JSON.parse` refuses) is stripped. Oversized dead tool-result
 * details are cut as bytes first — the same input the read-only manager uses.
 */
function parseFile(filePath: string, bytes: number): Record<string, unknown>[] {
  if (bytes >= SLIM_LOAD_MIN_FILE_BYTES && bytes <= SLIM_LOAD_MAX_FILE_BYTES) {
    return loadSlimSessionEntries(readFileSync(filePath)) as Record<string, unknown>[];
  }
  const text = readFileSync(filePath, "utf8");
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmed.trim()) continue;
    try {
      const entry = JSON.parse(trimmed.charCodeAt(0) === 0xfeff ? trimmed.slice(1) : trimmed) as unknown;
      if (isRecord(entry)) entries.push(entry);
    } catch {
      // A malformed line is skipped, as the SDK's loader skips it.
    }
  }
  return entries;
}

/**
 * `SessionManager.getTree()`: nodes keyed by entry id, roots for a null or
 * self parent and for orphans, children sorted oldest first by timestamp.
 */
function buildTree(
  entries: SessionEntry[],
  labels: Map<string, { label: string; timestamp: string }>,
): SessionTreeNode[] {
  const nodeMap = new Map<string, SessionTreeNode>();
  const roots: SessionTreeNode[] = [];
  for (const entry of entries) {
    const labelled = labels.get(entry.id);
    nodeMap.set(entry.id, {
      entry,
      children: [],
      label: labelled?.label,
      labelTimestamp: labelled?.timestamp,
    });
  }
  for (const entry of entries) {
    const node = nodeMap.get(entry.id)!;
    if (entry.parentId === null || entry.parentId === entry.id) {
      roots.push(node);
      continue;
    }
    const parent = nodeMap.get(entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Iterative: a linear session's tree is thousands of levels deep.
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
    stack.push(...node.children);
  }
  return roots;
}

function buildView(filePath: string, bytes: number): SessionFileView {
  const parsed = parseFile(filePath, bytes);
  // `loadEntriesFromFile` only accepts a file whose *first* line is a session
  // header; anything else is not a session, and the SDK path says so.
  const first = parsed[0];
  const headerIsValid = isRecord(first) && first.type === "session" && typeof first.id === "string";
  const header = (headerIsValid ? first : null) as SessionHeader | null;
  const entries = (headerIsValid ? parsed.slice(1) : []) as unknown as SessionEntry[];
  const version = header?.version;

  // `_buildIndex`: the leaf is the last entry, and label entries move it too.
  let leafId: string | null = null;
  const labels = new Map<string, { label: string; timestamp: string }>();
  for (const entry of entries) {
    leafId = entry.id;
    if (entry.type !== "label") continue;
    const label = entry as { targetId?: string; label?: string; timestamp?: string };
    if (!label.targetId) continue;
    if (label.label) labels.set(label.targetId, { label: label.label, timestamp: label.timestamp ?? "" });
    else labels.delete(label.targetId);
  }

  // `getSessionName()`: the newest `session_info`, empty clearing the title.
  let sessionName: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "session_info") continue;
    const name = (entry as { name?: unknown }).name;
    sessionName = typeof name === "string" ? name.trim() || undefined : undefined;
    break;
  }

  const needsSessionManager = !headerIsValid || typeof version !== "number" || version < CURRENT_SESSION_VERSION;

  return {
    filePath: resolvePath(filePath),
    header,
    entries,
    leafId,
    tree: needsSessionManager ? [] : buildTree(entries, labels),
    sessionName,
    bytes,
    needsSessionManager,
  };
}

/**
 * Read a session file, reusing a cached view while its on-disk fingerprint is
 * unchanged. Never throws for a missing file: callers resolve the path first.
 */
export function readSessionFile(filePath: string): SessionFileView {
  const resolved = resolvePath(filePath);
  const stats = fingerprintOf(resolved);
  const views = cache();
  const key = sessionPathKey(resolved);
  if (stats === null) {
    views.delete(key);
    return buildView(resolved, 0);
  }
  const cached = views.get(key);
  if (cached && cached.fingerprint === stats.fingerprint) {
    // LRU touch.
    views.delete(key);
    views.set(key, cached);
    return cached.view;
  }
  const view = buildView(resolved, stats.bytes);
  views.set(key, { view, fingerprint: stats.fingerprint });
  evict(views);
  return view;
}

/**
 * One session's entries for a caller that only needs them (the entries routes,
 * chat-access, file references): the same array the view holds, no manager.
 */
export function readSessionEntries(filePath: string): SessionEntry[] {
  return readSessionFile(filePath).entries;
}

/** The session file's folder, as `SessionManager.getSessionDir()` reports it. */
export function sessionFileDirectory(filePath: string): string {
  return dirname(resolvePath(filePath));
}
