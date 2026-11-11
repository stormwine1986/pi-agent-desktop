import { existsSync } from "fs";
import { realpathSync } from "fs";
import { resolve } from "path";
import { getSessionListVersion } from "./session-list";
import { readSubagentRun } from "./subagents";
import { userImageDisplayText, userMessageImageCount } from "./user-image-display";
import type { SessionEntry, SessionInfo, SessionMessageEntry } from "./types";

/**
 * The live-session registry, readable without the pi SDK (TASK-000110).
 *
 * `GET /api/sessions` reports the sessions that are running right now, so the
 * sidebar can show a spinner and a session can appear before its first JSONL
 * flush. That request is the first data request of a cold start, and the
 * desktop shell does not reveal its window before it answers — so it must not
 * pull in `@earendil-works/pi-coding-agent`, whose root import is a 37 MB
 * server-external graph (~1.4 s of blocked loop, TASK-000108).
 *
 * Nothing here needs the SDK: a wrapper is only ever read through the
 * structural view below. `lib/rpc-manager.ts` owns the wrappers (it creates,
 * starts and destroys them) and hands them over; `lib/first-screen-graph.test.mjs`
 * keeps the SDK out of what this module imports.
 */
export interface RegistrySessionManager {
  getHeader(): { id?: string; cwd?: string; timestamp?: string } | null;
  getEntries(): unknown[];
  getSessionFile(): string | undefined;
  getSessionName(): string | undefined;
}

export interface RegistrySession {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly cwd: string;
  readonly inner?: { readonly sessionManager?: RegistrySessionManager } | undefined;
  isAlive(): boolean;
  isRunning(): boolean;
  hasSuppressedCompletionNotifications(): boolean;
  /** A wrapper created before a hot reload may predate the method. */
  getPendingPromptPreview?(): { text: string; timestamp?: number } | undefined;
  /** The running-session cap's view of this wrapper; absent on a stale wrapper. */
  idleCapCandidate?(now: number): unknown;
  destroy(): void;
  shutdown(): unknown;
}

declare global {
  var __piSessions: Map<string, RegistrySession> | undefined;
}

/**
 * The registry map itself. Created lazily on first use and kept on
 * `globalThis` so a hot reload neither loses the live sessions nor leaves the
 * old map's shutdown handlers unowned.
 */
export function sessionRegistry(): Map<string, RegistrySession> {
  if (!globalThis.__piSessions) {
    globalThis.__piSessions = new Map();
    const destroy = () => globalThis.__piSessions?.forEach((session) => session.destroy());
    const shutdown = () => {
      const sessions = Array.from(globalThis.__piSessions?.values() ?? []);
      void Promise.allSettled(sessions.map((session) => session.shutdown()));
    };
    // Node cannot await work from an exit handler; direct destruction starts
    // extension cleanup synchronously as a final best effort.
    process.once("exit", destroy);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return globalThis.__piSessions;
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  if (typeof content === "string") return content;
  return content
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join(" ");
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(options: { includeTransient?: boolean } = {}): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of sessionRegistry().values()) {
    if (typeof session.isAlive !== "function" || !session.isAlive()) continue;

    const manager = session.inner?.sessionManager;
    if (!manager) continue;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const pendingPrompt = session.getPendingPromptPreview?.();
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));
    const subagent = readSubagentRun(entries as unknown as SessionEntry[], header?.id ?? session.sessionId, sessionFile ?? "");

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Show submitted prompts even before the SDK records them.
    if (!persisted && !options.includeTransient && (!session.isRunning() || (!firstUserMessage && !pendingPrompt))) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = pendingPrompt?.timestamp ?? (Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp);
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: (firstUserMessage
        ? userImageDisplayText(runtimeMessageText(firstUserMessage), userMessageImageCount("content" in firstUserMessage.message ? firstUserMessage.message.content : undefined))
        : pendingPrompt?.text) || "(no messages)",
      ...(subagent ? {
        parentSessionId: subagent.parentSessionId,
        relation: {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          profile: subagent.profile,
          description: subagent.description,
          status: session.isRunning() ? "running" as const : subagent.status,
        },
      } : {}),
      transient: !persisted,
    });
  }
  return sessions;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of sessionRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

export function getCompletionNotificationSuppressedRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of sessionRegistry()) {
    if (session.isRunning() && session.hasSuppressedCompletionNotifications()) {
      ids.add(session.sessionId || sessionId);
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Running-state broadcasts and cwd-scoped lookups.
//
// These were part of `lib/rpc-manager.ts` until TASK-000113, which moved them
// here because the first screen asks for them: `GET /api/agent/running/events`
// is an SSE stream opened before the window is shown, and it only ever needs
// the structural view above. Importing them from `rpc-manager` loaded the whole
// agent runtime (37 MB server-external SDK, ~1.4 s of blocked loop) on that
// request. `rpc-manager` re-exports them, so its importers are unchanged.
// ---------------------------------------------------------------------------

declare global {
  var __piRunningListeners: Set<(ids: string[]) => void> | undefined;
  var __piStartingSessionCwds: Map<string, number> | undefined;
}

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__piRunningListeners) globalThis.__piRunningListeners = new Set();
  return globalThis.__piRunningListeners;
}

export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const ids = getRunningRpcSessionIds();
  // List changes (including an unpersisted prompt appearing/disappearing)
  // must reach every window even when the running id set stays unchanged.
  const snapshot = JSON.stringify({ ids: [...ids].sort(), version: getSessionListVersion() });
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

export function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__piStartingSessionCwds) globalThis.__piStartingSessionCwds = new Map();
  return globalThis.__piStartingSessionCwds;
}

/** Brackets one start for `cwd`, so a busy check sees a session being built. */
export function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

/** A session in `cwd` is running, or being started. */
export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(sessionRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(sessionRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

/**
 * Resolves with the live wrapper for `sessionId` as soon as there is one.
 * Used by the agent event stream, which no longer starts a runtime of its own
 * (TASK-000113): a restored chat's window is shown before anything starts an
 * agent, and the stream attaches when a prompt's `startRpcSession()` registers
 * one. Rejects on abort, so a closed stream leaves nothing waiting.
 */
export function waitForSession(sessionId: string, signal?: AbortSignal): Promise<RegistrySession> {
  const existing = sessionRegistry().get(sessionId);
  if (existing && (typeof existing.isAlive !== "function" || existing.isAlive())) return Promise.resolve(existing);
  return new Promise<RegistrySession>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const listeners = getSessionRegistryListeners();
    const onRegister = (id: string) => {
      if (id !== sessionId) return;
      const session = sessionRegistry().get(id);
      if (!session) return;
      cleanup();
      resolvePromise(session);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const cleanup = () => {
      listeners.delete(onRegister);
      signal?.removeEventListener("abort", onAbort);
    };
    listeners.add(onRegister);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

declare global {
  var __piSessionRegistryListeners: Set<(id: string) => void> | undefined;
}

function getSessionRegistryListeners(): Set<(id: string) => void> {
  if (!globalThis.__piSessionRegistryListeners) globalThis.__piSessionRegistryListeners = new Set();
  return globalThis.__piSessionRegistryListeners;
}

/** Told the id of every wrapper `rpc-manager` puts in the registry. */
export function notifySessionRegistered(sessionId: string): void {
  for (const listener of getSessionRegistryListeners()) {
    try { listener(sessionId); } catch { /* ignore listener errors */ }
  }
}
