import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-list";
import { sessionRegistry } from "@/lib/session-registry";
import { getComposerQueueVersion, getPendingComposerMessages } from "@/lib/composer-queue";

/**
 * A session's live agent state, or the part of it that survives without one.
 *
 * First-screen read (TASK-000113): the restored chat asks for this right after
 * its history. With no live wrapper there is no state to ask for — the answer
 * is `{ running: false }` plus any queued composer messages — so this route
 * imports the pi SDK only when a wrapper actually exists (a dynamic import the
 * live path pays; a cold start does not). Opening a stream no longer creates a
 * runtime either (`app/api/agent/[id]/events/route.ts`), so a restored chat
 * really is not running until the user sends something.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const registered = sessionRegistry().get(id);
    if (registered && (typeof registered.isAlive !== "function" || registered.isAlive())) {
      const { getRpcSession } = await import("@/lib/rpc-manager");
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        const state = await rpc.send({ type: "get_state" });
        return NextResponse.json({ running: true, state });
      }
    }

    if (!await resolveSessionPath(id)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const pending = getPendingComposerMessages(id);
    return NextResponse.json({ running: false, ...(pending.length ? { state: { queuedMessages: { pending, pendingVersion: getComposerQueueVersion(id) } } } : {}) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
