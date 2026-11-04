import { randomUUID } from "node:crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";

/**
 * Starting the task an event asks for: a normal pi session in the project the
 * subscription belongs to, whose first message is the event payload (plus the
 * extra prompt from subscriptions.yaml).
 *
 * Deliberately fire-and-forget: the session keeps running on its own and shows
 * up on the Tasks page. Blocking the event stream on a model call would let one
 * slow turn stall every other event from that source.
 */
export interface TaskSessionLike {
  send(command: unknown): Promise<unknown>;
}

export type StartTaskSession = (cwd: string) => Promise<{ session: TaskSessionLike; sessionId: string }>;

const defaultStartSession: StartTaskSession = async (cwd) => {
  // Loaded on demand: pulling the whole agent runtime into every module that
  // imports the subscriptions runner (including the boot hook) is wasteful.
  const { startRpcSession } = await import("@/lib/rpc-manager");
  const { session, realSessionId } = await startRpcSession(
    `__subscription__${randomUUID()}`,
    "",
    cwd,
    { allowInitialModelFallback: true },
  );
  return { session, sessionId: realSessionId };
};

export interface StartTaskInput {
  cwd: string;
  title: string;
  prompt: string;
}

export type StartTaskResult = { sessionId: string } | { error: string };

export async function startSubscriptionTask(
  input: StartTaskInput,
  startSession: StartTaskSession = defaultStartSession,
): Promise<StartTaskResult> {
  try {
    const { session, sessionId } = await startSession(input.cwd);
    // The files route keeps its own allowed-roots cache; a session that was
    // started without a page open would otherwise be unreadable for a while.
    allowFileRoot(input.cwd);
    invalidateSessionListCache();
    // A missing title only costs a less readable sidebar row.
    await session.send({ type: "set_session_name", name: input.title }).catch(() => undefined);
    await session.send({ type: "prompt", message: input.prompt });
    return { sessionId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
