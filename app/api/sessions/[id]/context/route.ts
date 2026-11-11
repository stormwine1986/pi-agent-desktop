import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-list";
import { readSessionFile } from "@/lib/session-read";
import { buildSessionContext } from "@/lib/session-context";
import { sessionRegistry, type RegistrySession } from "@/lib/session-registry";
import type { SessionEntry } from "@/lib/types";

/**
 * One page of a session's history.
 *
 * Like `GET /api/sessions/[id]` beside it, this is a first-screen read: a chat
 * that restores with history paged in asks for it, and neither may load the pi
 * SDK (TASK-000113). Entries come from the JSONL file (`lib/session-read.ts`);
 * a live wrapper's own manager is read through a structural view, and a file
 * older than the current format falls back to `SessionManager` dynamically.
 */

interface LiveSessionManager {
  getEntries(): SessionEntry[];
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  // `tail` caps the ancestor chain returned (default 50); `before` rewinds the
  // walk start to an older entry so the client can page upward without
  // re-fetching the whole active branch.
  const rawTail = Number(url.searchParams.get("tail"));
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const before = url.searchParams.get("before") ?? undefined;
  // Chat-view loads ask for whole turns so a window never cuts a turn in half;
  // without the flag `tail` is an exact cap on the returned ancestor chain.
  const wholeTurns = url.searchParams.has("wholeTurns");

  try {
    const registered = sessionRegistry().get(id) as RegistrySession | undefined;
    const liveRpc = registered && (typeof registered.isAlive !== "function" || registered.isAlive())
      ? registered
      : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    let entries: SessionEntry[];
    if (liveRpc) {
      const manager = liveRpc.inner?.sessionManager as unknown as LiveSessionManager | undefined;
      if (!manager) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      entries = manager.getEntries();
    } else {
      const view = readSessionFile(filePath!);
      if (view.needsSessionManager) {
        const { openSessionManager } = await import("@/lib/session-reader");
        entries = openSessionManager(filePath!).getEntries() as unknown as SessionEntry[];
      } else {
        entries = view.entries;
      }
    }

    // `before` is the oldest entry already on the client; fetch its ancestors
    // only (excludeLeaf) so prepending the page does not duplicate `before`.
    const context = buildSessionContext(entries as never, before ?? leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      excludeLeaf: Boolean(before),
      wholeTurns,
      sessionId: id,
    });

    return NextResponse.json({ context, tail, before: before ?? null });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
