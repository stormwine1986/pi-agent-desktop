import { createAgentEventStream, type AgentEventStreamSession } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-list";
import { sessionRegistry, waitForSession, type RegistrySession } from "@/lib/session-registry";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
//
// This stream used to *start* the agent runtime when no wrapper existed
// (`startRpcSession`), which meant the first screen of a cold start created an
// AgentSession for a chat nobody had touched yet — and paid the pi SDK's whole
// root graph (~1.4 s of blocked loop) doing it, on the request right after the
// history read (TASK-000113). A restored chat is not running, so there is
// nothing to stream: the stream now opens, waits for a wrapper, and attaches
// the moment one appears (the request that needs one starts it: a prompt
// through `POST /api/agent/[id]`, a scheduled task, a dispatch). Nothing on
// this path imports the SDK.
//
// The `connected` frame a client expects is still published as soon as the
// wrapper exists, and a client that reconnects while an agent runs finds it in
// the registry, so the snapshot is unchanged for the case that matters.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  const registered = sessionRegistry().get(id) as RegistrySession | undefined;
  const live = registered && (typeof registered.isAlive !== "function" || registered.isAlive())
    ? registered
    : undefined;

  // Fast path: already-running session. Otherwise the stream waits for one
  // instead of building it. A session that does not exist is still a 404.
  let sessionPromise: Promise<AgentEventStreamSession>;
  if (live) {
    sessionPromise = Promise.resolve(live as unknown as AgentEventStreamSession);
  } else {
    if (!await resolveSessionPath(id)) {
      return new Response("Session not found", { status: 404 });
    }
    if (req.signal.aborted) return new Response(null, { status: 204 });
    sessionPromise = waitForSession(id, req.signal).then(
      (session) => session as unknown as AgentEventStreamSession,
    );
  }

  const stream = createAgentEventStream(req, id, sessionPromise);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
