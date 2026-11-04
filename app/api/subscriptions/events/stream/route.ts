import { resolve } from "node:path";
import { subscribeToWorkspaceEvents } from "@/lib/subscriptions/runner";
import type { EventRecord } from "@/lib/subscriptions/store";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

/**
 * Live tail for the Subscriptions page: new events only. The page loads the
 * snapshot first (which is also what starts collection), then keeps this stream
 * open so rows appear as they are recorded.
 *
 * SSE rather than polling because the page already speaks it, and because the
 * runner is an in-process fanout: no extra query per event is needed.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("cwd");
  if (!raw) return new Response("cwd is required", { status: 400 });
  const cwd = resolve(raw);

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const unsubscribe = subscribeToWorkspaceEvents(cwd, (event: EventRecord) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => write(": hb\n\n"), HEARTBEAT_MS);
      // A long-lived response must not keep a serverless/lambda-ish runtime awake.
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      req.signal.addEventListener("abort", cleanup, { once: true });
      write(": connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
