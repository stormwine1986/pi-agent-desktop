import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { attachSessionProjectInfo, resolveSessionIdByPath, resolveSessionPath } from "@/lib/session-list";
import { readSessionFile } from "@/lib/session-read";
import { buildSessionContext } from "@/lib/session-context";
import { sessionRegistry, type RegistrySession } from "@/lib/session-registry";
import { projectTreeForResponse, toSummaryTree } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { startServerPerf } from "@/lib/perf";
import { computeSessionRevision } from "@/lib/session-revision";
import type { SessionEntry, SessionHeader } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { jsonResponse } from "@/lib/json-response";

/**
 * One session's first screen: header info, tree, context window, stats.
 *
 * This is the request the desktop shell waits for on a cold start that restores
 * a chat (`hooks/useAgentSession.ts` clears loading with it, and the shell keeps
 * the window hidden until then), so its static import graph must not reach
 * `@earendil-works/*` — the SDK's package root is a 37 MB server-external graph
 * and one symbol from it blocks the loop for ~1.4 s (TASK-000108, TASK-000110,
 * TASK-000113).
 *
 * Everything a read needs therefore comes from files, not from a
 * `SessionManager` (see `lib/session-read.ts`). Two deliberate escape hatches:
 * a *live* wrapper's own manager is read through a structural view (it is
 * already in memory; no import needed), and a file older than the current
 * session format is handed to `SessionManager` through a dynamic import, which
 * is what rewrites it. The write methods (PATCH/DELETE) live in `./mutations`,
 * imported only when one of them arrives.
 */

/** The parts of a live wrapper's manager this route reads. */
interface LiveSessionManager {
  getEntries(): SessionEntry[];
  getLeafId(): string | null;
  getTree(): Parameters<typeof projectTreeForResponse>[0];
  getSessionName(): string | undefined;
  getHeader(): SessionHeader | null;
  getSessionFile(): string | undefined;
}

/** A wrapper created before a hot reload may predate `evictIfDiskAhead`. */
type LiveSession = RegistrySession & { evictIfDiskAhead?(): boolean };

function liveManager(session: LiveSession): LiveSessionManager {
  return session.inner?.sessionManager as unknown as LiveSessionManager;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const perf = startServerPerf("GET /api/sessions/[id]");
  try {
    perf?.span("resolve");
    const registered = sessionRegistry().get(id) as LiveSession | undefined;
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends pi-web itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = registered && (typeof registered.isAlive !== "function" || registered.isAlive())
      ? registered
      : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead?.()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    let entries: SessionEntry[];
    let leafId: string | null;
    let tree: ReturnType<typeof projectTreeForResponse>;
    let sessionName: string | undefined;
    let header: SessionHeader | null;
    let filePath: string;
    if (liveRpc) {
      const sm = liveManager(liveRpc);
      entries = sm.getEntries();
      leafId = sm.getLeafId();
      tree = projectTreeForResponse(sm.getTree());
      sessionName = sm.getSessionName();
      header = sm.getHeader();
      filePath = liveRpc.sessionFile || sm.getSessionFile() || "";
    } else {
      const view = readSessionFile(resolvedPath!);
      if (view.needsSessionManager) {
        // A session older than the current format, or not a session at all:
        // the SDK's manager migrates (and writes) it, and refuses the latter.
        const { openSessionManager } = await import("@/lib/session-reader");
        const sm = openSessionManager(resolvedPath!);
        entries = sm.getEntries() as unknown as SessionEntry[];
        leafId = sm.getLeafId();
        tree = projectTreeForResponse(sm.getTree());
        sessionName = sm.getSessionName();
        header = sm.getHeader() as unknown as SessionHeader | null;
        filePath = sm.getSessionFile() || resolvedPath!;
      } else {
        entries = view.entries;
        leafId = view.leafId;
        tree = projectTreeForResponse(view.tree);
        sessionName = view.sessionName;
        header = view.header;
        filePath = view.filePath;
      }
    }
    perf?.span("open");
    const summaryTree = searchParams.get("tree") === "summary";
    if (summaryTree) tree = toSummaryTree(tree);
    perf?.span("tree");
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    // Chat-view loads ask for whole turns; the default keeps `tail` an exact cap.
    const wholeTurns = searchParams.has("wholeTurns");
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      wholeTurns,
      sessionId: id, // local: lazy URLs for historical tool-result images
    });
    perf?.span("context");
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    perf?.span("stats");
    // Opaque freshness token for the session view cache. Derived from the
    // disk fingerprint and the actual read source; null tells the client the
    // snapshot is unstable and must not be cached as fresh.
    const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
    const snapshotRevision = computeSessionRevision({
      filePath,
      sourceId: liveRpc ? `runtime:${String(liveRpc.sessionId)}` : "disk",
      entryCount: entries.length,
      latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
      leafId: leafId ?? null,
    });
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    const body = {
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      ...(summaryTree ? { treeFormat: "summary" as const } : {}),
      snapshotRevision,
      context,
      stats,
      totalActiveMs,
      ...(toolNames !== undefined ? { toolNames } : {}),
      ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
    };

    return perf?.attach(jsonResponse(req, body)) ?? jsonResponse(req, body);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// Both write methods need the SDK (`SessionManager` appends, the agent runtime
// shuts wrappers down), which is why they are not in this module's static
// graph. See ./mutations.
export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { PATCH: patch } = await import("./mutations");
  return patch(req, context);
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { DELETE: remove } = await import("./mutations");
  return remove(req, context);
}
