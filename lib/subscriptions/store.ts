import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import type { SubscriptionAction } from "./config";
import { extractEventColumns } from "./event-fields";

/**
 * Received events, appended one JSON object per line so a restart keeps them
 * and so a partially written tail can be ignored instead of losing the file.
 *
 * JSONL rather than sqlite: the volume is a handful of events per minute, the
 * only query is "the newest N for this workspace", and a text file can be read
 * with `tail` while the app is running.
 */
export interface EventRecord {
  seq: number;
  receivedAt: string;
  /** Workspace whose `subscriptions.yaml` produced this event. */
  cwd: string;
  source: string;
  eventType: string;
  entityType: string | null;
  workspaceId: string | null;
  state: string | null;
  /** Business key carried by the event; null when the source sends none. */
  key: string | null;
  action: SubscriptionAction;
  eventId: string | null;
  data: unknown;
}

export interface CursorEntry {
  lastEventId: string;
  updatedAt: string;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const KEEP_RECORDS_ON_TRIM = 1_500;
const MAX_DATA_CHARS = 16_384;
const DEFAULT_LIMIT = 200;

export function subscriptionStoreDir(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "subscriptions");
}

export function eventLogPath(dir = subscriptionStoreDir()): string {
  return join(dir, "events.jsonl");
}

export function cursorPath(dir = subscriptionStoreDir()): string {
  return join(dir, "cursors.json");
}

export function statePath(dir = subscriptionStoreDir()): string {
  return join(dir, "state.json");
}

interface WorkspaceState {
  /** Events recorded since the page last showed this workspace. */
  unread: number;
  /** Highest seq written for this workspace (kept for diagnostics). */
  lastSeq: number;
}

/** Windows hands the same folder over with different separators; one key per folder. */
function stateKey(cwd: string): string {
  return resolve(cwd);
}

function readStates(dir: string): Record<string, WorkspaceState> {
  const path = statePath(dir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const states: Record<string, WorkspaceState> = {};
    for (const [cwd, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { unread?: unknown; lastSeq?: unknown };
      if (typeof entry?.unread === "number" || typeof entry?.lastSeq === "number") {
        states[stateKey(cwd)] = {
          unread: typeof entry.unread === "number" ? entry.unread : 0,
          lastSeq: typeof entry.lastSeq === "number" ? entry.lastSeq : 0,
        };
      }
    }
    return states;
  } catch {
    return {};
  }
}

function writeStates(states: Record<string, WorkspaceState>, dir: string): void {
  mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(statePath(dir), JSON.stringify(states, null, 2));
}

/** How many recorded events the user has not looked at yet. */
export function readUnreadCount(cwd: string, dir = subscriptionStoreDir()): number {
  const state = readStates(dir)[stateKey(cwd)];
  return state ? Math.max(0, state.unread) : 0;
}

/** Called when the Subscriptions page shows the workspace: everything is seen. */
export function markWorkspaceSeen(cwd: string, dir = subscriptionStoreDir()): number {
  const states = readStates(dir);
  const key = stateKey(cwd);
  const state = states[key];
  if (!state || state.unread === 0) return 0;
  states[key] = { ...state, unread: 0 };
  writeStates(states, dir);
  return 0;
}

/**
 * A counter rather than `lastSeq - seenSeq`: seq is global across workspaces, so
 * subtracting watermarks would count another project's events.
 */
function recordAppended(records: readonly EventRecord[], dir: string): void {
  const states = readStates(dir);
  for (const record of records) {
    const key = stateKey(record.cwd);
    const current = states[key];
    states[key] = {
      unread: (current?.unread ?? 0) + 1,
      lastSeq: Math.max(current?.lastSeq ?? 0, record.seq),
    };
  }
  if (records.length > 0) writeStates(states, dir);
}

let lastSeq = 0;
let seqInitializedFor: string | null = null;

function ensureSeq(path: string): number {
  if (seqInitializedFor === path) return lastSeq;
  lastSeq = 0;
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    const lines = text.trimEnd().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as { seq?: unknown };
        if (typeof parsed.seq === "number") {
          lastSeq = parsed.seq;
          break;
        }
      } catch {
        // A truncated tail line is expected after a crash; keep looking up.
      }
    }
  }
  seqInitializedFor = path;
  return lastSeq;
}

function truncateData(data: unknown): unknown {
  try {
    const text = JSON.stringify(data);
    if (text && text.length > MAX_DATA_CHARS) {
      return { truncated: true, preview: `${text.slice(0, MAX_DATA_CHARS)}…` };
    }
    return data ?? null;
  } catch {
    return null;
  }
}

function trimIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  if (statSync(path).size <= MAX_FILE_BYTES) return;
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const kept = lines.slice(-KEEP_RECORDS_ON_TRIM);
  writePrivateFileAtomicSync(path, `${kept.join("\n")}\n`);
}

export type NewEventRecord = Omit<EventRecord, "seq">;

export function appendEventRecords(records: readonly NewEventRecord[], dir = subscriptionStoreDir()): EventRecord[] {
  if (records.length === 0) return [];
  mkdirSync(dir, { recursive: true });
  const path = eventLogPath(dir);
  let seq = ensureSeq(path);
  const written: EventRecord[] = records.map((record) => {
    seq += 1;
    return { ...record, data: truncateData(record.data), seq };
  });
  // One write per batch keeps a burst of events from becoming N syscalls.
  writeFileSync(path, `${written.map((record) => JSON.stringify(record)).join("\n")}\n`, { flag: "a" });
  lastSeq = seq;
  recordAppended(written, dir);
  trimIfNeeded(path);
  return written;
}

function parseLines(text: string): EventRecord[] {
  const records: EventRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as EventRecord;
      if (typeof parsed?.seq === "number" && typeof parsed.cwd === "string") records.push(parsed);
    } catch {
      // Ignore the torn last line; everything before it is still valid.
    }
  }
  return records;
}

export function readEventRecords(options: {
  cwd?: string;
  limit?: number;
  dir?: string;
} = {}): EventRecord[] {
  const { cwd, limit = DEFAULT_LIMIT, dir = subscriptionStoreDir() } = options;
  const path = eventLogPath(dir);
  if (!existsSync(path)) return [];
  let records = parseLines(readFileSync(path, "utf8"));
  if (cwd) records = records.filter((record) => record.cwd === cwd);
  // Events written before the `key` column existed still carry it in `data`;
  // derive it on read instead of leaving a dash in a column that has a value.
  records = records.map((record) => (
    record.key === undefined || record.key === null
      ? { ...record, key: extractEventColumns(record.data).key }
      : record
  ));
  return records.slice(-limit);
}

export function readCursors(dir = subscriptionStoreDir()): Record<string, Record<string, CursorEntry>> {
  const path = cursorPath(dir);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, Record<string, CursorEntry>>;
  } catch {
    return {};
  }
}

export function readCursor(cwd: string, source: string, dir = subscriptionStoreDir()): string | null {
  return readCursors(dir)[cwd]?.[source]?.lastEventId ?? null;
}

export function writeCursor(cwd: string, source: string, lastEventId: string, dir = subscriptionStoreDir()): void {
  mkdirSync(dir, { recursive: true });
  const cursors = readCursors(dir);
  cursors[cwd] = { ...(cursors[cwd] ?? {}), [source]: { lastEventId, updatedAt: new Date().toISOString() } };
  writePrivateFileAtomicSync(cursorPath(dir), JSON.stringify(cursors, null, 2));
}
