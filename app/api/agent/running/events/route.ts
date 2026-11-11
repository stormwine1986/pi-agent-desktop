import { getRunningRpcSessionIds, subscribeRunningSessions } from "@/lib/session-registry";
import { getSessionListVersion } from "@/lib/session-list";
import { getSubscriptionRuntimeSnapshot, subscribeSubscriptionRuntime } from "@/lib/events/runtime";

export const dynamic = "force-dynamic";

// The running set is read from the SDK-free registry, and the session-list
// version from the SDK-free half of the catalogue (TASK-000113): this stream
// opens before the desktop window is shown, and importing `lib/rpc-manager` or
// `lib/session-reader` for either number loaded the whole pi SDK there (~1.4 s
// of blocked loop). Nothing here starts or drives an agent.

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes an update whenever any session starts or stops working,
// so the sidebar never has to poll.
export async function GET(req: Request) {
  let dispose = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe = () => {};
      let unsubscribeSubscriptions = () => {};
      // Both halves of the frame are read from the same snapshot, so a client
      // never sees a running id without the subscription story that explains it.
      const subscriptionFields = () => {
        const subscriptions = getSubscriptionRuntimeSnapshot();
        return {
          subscribedSessionIds: subscriptions.subscribedSessionIds,
          subscriptionHealth: subscriptions.subscriptionHealth,
        };
      };
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe();
        unsubscribeSubscriptions();
        req.signal?.removeEventListener("abort", cleanup);
        try { controller.close(); } catch { /* already closed/cancelled */ }
      };
      dispose = cleanup;
      req.signal?.addEventListener("abort", cleanup);
      const encode = (data: unknown) => {
        if (closed) return false;
        const text = `data: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(text));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription. Every frame carries
      // the session-list version: renames/deletes/creates in other windows bump
      // it, letting connected sidebars refetch without waiting for focus.
      const nextUnsubscribe = subscribeRunningSessions((ids) => {
        encode({ type: "running", runningSessionIds: ids, sessionListVersion: getSessionListVersion(), ...subscriptionFields() });
      });
      if (closed) nextUnsubscribe();
      else unsubscribe = nextUnsubscribe;

      // A subscription appearing, turning unavailable or being delivered to is
      // a change of this same picture: push it, do not make the sidebar poll.
      const nextSubscriptionUnsubscribe = subscribeSubscriptionRuntime(() => {
        encode({ type: "running", runningSessionIds: getRunningRpcSessionIds(), sessionListVersion: getSessionListVersion(), ...subscriptionFields() });
      });
      if (closed) nextSubscriptionUnsubscribe();
      else unsubscribeSubscriptions = nextSubscriptionUnsubscribe;

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      encode({ type: "running", runningSessionIds: getRunningRpcSessionIds(), sessionListVersion: getSessionListVersion(), ...subscriptionFields() });

      // Heartbeat to keep the connection alive through proxies/timeouts.
      if (!closed) heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(":\n\n")); }
        catch { cleanup(); }
      }, 30_000);

    },
    cancel() {
      dispose();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
