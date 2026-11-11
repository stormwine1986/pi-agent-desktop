import { SessionManager } from "@earendil-works/pi-coding-agent";

import { statSync } from "fs";
import type { AgentMessage, ImageContent, SessionEntry, SessionContext } from "./types";
import { normalizeToolCalls } from "./normalize";
import { getThinkingPreview } from "./message-display";
import { sessionPathKey } from "./session-path";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images";
import { projectToolResultDetails, slimToolResultMessage } from "./tool-result-details";
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

export function getLatestModelChange(entries: SessionEntry[]): SessionContext["model"] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "model_change") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
  }
  return null;
}

/** Model from the newest assistant response metadata — the fallback the
 *  pre-wrapper UI displays when a session has no model_change entries. */
export function getLatestResponseModel(entries: SessionEntry[]): SessionContext["model"] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as { provider?: unknown; model?: unknown };
      if (typeof message.provider === "string" && typeof message.model === "string") {
        return { provider: message.provider, modelId: message.model };
      }
    }
  }
  return null;
}

function getSessionSettings(entries: SessionEntry[], leafId?: string | null): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (leafId === null) return { thinkingLevel: "off", model: null };
  const branch = sliceActiveBranch(entries, leafId ?? null, entries.length);
  let thinkingLevel: string | undefined;

  for (let i = branch.length - 1; i >= 0 && thinkingLevel === undefined; i--) {
    const entry = branch[i];
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    }
  }

  return {
    thinkingLevel: thinkingLevel ?? "off",
    model: getLatestModelChange(branch) ?? getLatestResponseModel(branch),
  };
}

export interface BuildSessionContextOptions {
  deferThinking?: boolean;
  deferToolResultImages?: boolean;
  tail?: number;
  excludeLeaf?: boolean;
  /**
   * Let a page run past `tail` to open on a whole turn (its leading user
   * message) instead of cutting a turn in half. Chat-view loads set this so a
   * window that stops mid-turn does not render that turn's leading messages
   * flat. API callers leave it unset: for them `tail` is an exact cap on the
   * ancestor chain (the documented route contract, pinned by e2e).
   */
  wholeTurns?: boolean;
  /** Session id used to build lazy URLs for historical tool-result images. */
  sessionId?: string;
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const { tail, excludeLeaf, wholeTurns } = options;
  // History pages retain the original branch order, including compacted messages.
  // SDK context filtering can drop a page's messages when firstKeptEntryId is outside it.
  const sliced = leafId === null ? [] : sliceActiveBranch(
    entries, leafId ?? null, tail && tail > 0 ? tail : entries.length, excludeLeaf, wholeTurns,
  );
  const hasMore = Boolean(tail && tail > 0 && sliced[0]?.parentId);

  // Convert messages and their IDs together to keep fork/navigation targets aligned.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of sliced) {
    const m = entryToUiMessage(entry, options);
    if (m) {
      messages.push(m);
      entryIds.push(entry.id);
    }
  }

  return {
    messages,
    entryIds,
    oldestEntryId: sliced[0]?.id ?? null,
    hasMore,
    ...getSessionSettings(entries, leafId),
  };
}

/**
 * Entry that renders as a standalone visible message in the chat window:
 * user / assistant messages plus the compaction divider. toolResult entries,
 * hidden custom messages and session meta render as attachments or nothing,
 * so they must not consume the `tail` budget — counting raw entries starves
 * user messages out of the window in agent-heavy sessions (a 50-entry window
 * over a tool-heavy session can hold a single user message).
 */
function countsTowardTail(entry: SessionEntry): boolean {
  if (entry.type === "compaction") return true;
  if (entry.type === "branch_summary") return Boolean((entry as { summary?: string }).summary);
  if (entry.type !== "message") return false;
  const role = (entry as { message?: { role?: string } }).message?.role;
  return role === "user" || role === "assistant";
}

/**
 * Raw-entry ceiling for one page, so a span of tool traffic with few visible
 * anchors cannot balloon the payload. Scaled with `tail`; older history still
 * pages in via `before`.
 */
const MIN_RAW_WINDOW_ENTRIES = 200;
const rawWindowCap = (tail: number) => Math.max(MIN_RAW_WINDOW_ENTRIES, tail * 6);

/**
 * Extract the ancestor chain from `leafId` back toward the root, capped at
 * `tail` visible entries (most-recent first after the final reverse).
 * Iterative: a linear session's chain length equals its entry count, so a
 * recursive walk would overflow the stack. The result is still a valid prefix
 * of the active branch — older history is loaded on demand via pagination.
 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
  wholeTurns = false,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  // Pagination: `before` is the oldest entry already loaded, so the next page
  // must start at its parent to avoid duplicating `before` when prepended.
  if (excludeLeaf) leaf = leaf?.parentId ? byId.get(leaf.parentId) : undefined;
  if (!leaf) return [];
  const chain: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  let visible = 0;
  const rawCap = rawWindowCap(tail);
  while (current) {
    chain.push(current);
    if (countsTowardTail(current)) visible++;
    if (visible >= tail || chain.length >= rawCap) break;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  // A window that stops mid-turn renders that turn's leading messages flat —
  // ChatWindow can only fold a turn into "Process details" from its anchor —
  // until the older page arrives and they collapse. Walk back to the anchor
  // so the page opens on whole turns; a turn too long to reach is left cut.
  // `wholeTurns` is opt-in: without it `tail` is an exact cap (API contract).
  if (wholeTurns && current && !startsTurn(current)) {
    const extension: SessionEntry[] = [];
    let cursor = current.parentId ? byId.get(current.parentId) : undefined;
    while (cursor && extension.length < MAX_TURN_EXTENSION_ENTRIES) {
      extension.push(cursor);
      if (startsTurn(cursor)) {
        chain.push(...extension);
        break;
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  chain.reverse();
  return chain;
}

/** Extra raw entries a page may take to reach the start of the turn it cut into. */
const MAX_TURN_EXTENSION_ENTRIES = 1500;

/** Entries that `isMessageGroupAnchor()` treats as the start of a displayed turn. */
function startsTurn(entry: SessionEntry): boolean {
  if (entry.type === "compaction") return true;
  if (entry.type === "custom_message") {
    return (entry as { customType?: string }).customType === "pi-web:subagent-notification";
  }
  if (entry.type === "branch_summary") return Boolean((entry as { summary?: string }).summary);
  return entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user";
}
function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function deferToolResultBase64Images(
  message: AgentMessage,
  sessionId: string | undefined,
  entryId: string,
): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.flatMap((block, blockIndex) => {
    const image = base64ImageInfo(block);
    if (!image) return [block];

    // Keep the initial history response small, but preserve an image block that
    // the browser can load only when its collapsed tool result is expanded.
    if (
      sessionId &&
      image.mime &&
      TOOL_RESULT_IMAGE_MIMES.has(image.mime) &&
      image.bytes > 0 &&
      image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES
    ) {
      const source: ImageContent["source"] = {
        type: "url",
        media_type: image.mime,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result-image?blockIndex=${blockIndex}`,
      };
      return [{ type: "image", source } satisfies ImageContent];
    }

    // Retain the old bounded fallback for callers that do not have a session id.
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return [];
  });
  if (omitted === 0) return { ...message, content };

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: BuildSessionContextOptions,
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      // Transcript system messages carry the prompt and tool loadout (Pi >= 0.86).
      // They are provider input, not conversation, so they never render.
      if (entry.message.role === "system") return null;
      // Tool-result details are projected to the fields the UI renders:
      // extensions can persist megabytes there (see lib/tool-result-details.ts).
      const normalized = slimToolResultMessage(normalizeToolCalls(entry.message));
      let message = options.deferToolResultImages
        ? deferToolResultBase64Images(normalized, options.sessionId, entry.id)
        : normalized;
      const legacyContent = message.role === "assistant" ? (message as { content: unknown }).content : undefined;
      if (typeof legacyContent === "string") {
        message = { ...message, content: [{ type: "text", text: legacyContent }] } as AgentMessage;
      }
      if (!options.deferThinking || message.role !== "assistant") return message;
      const content = message.content;
      return {
        ...message,
        content: content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: getThinkingPreview(block.thinking), deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      // A divider like compaction, not a user bubble: it was never typed, so it must not
      // offer Edit / Fork or be counted as the user's turn.
      return {
        role: "custom",
        customType: "branch_summary",
        content: entry.summary,
        display: true,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}


