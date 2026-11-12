/**
 * `action: wake` — inject a prompt into an existing session so it runs a turn.
 *
 * The lifecycle rules this follows (SSR-000097【反应与投递】):
 * - the session must exist; a subscription whose `sessionId` is not on disk is
 *   reported, never created (`ifNotRunning` does not create anything);
 * - a session that exists but is not loaded is *resumed*: same id, same file;
 * - a session that is running is **not interrupted**: the caller parks the batch
 *   (`pendingBatch`) and delivers once when the turn ends (M2);
 * - one injection at a time per session — the caller serializes this.
 *
 * The two modules below are the pi SDK's front door (a session runtime and its
 * session store). They are imported when a delivery actually happens, not when
 * this file is loaded: the event runtime is registered from the instrumentation
 * hook, and the SDK is a 1.5–2.3 s synchronous module load that must not sit in
 * front of the desktop shell's identity probe (DEFECT-000090).
 */
const sessionRuntime = () => import("../rpc-manager");
const sessionReader = () => import("../session-reader");

export type DeliveryOutcome =
  | { status: "delivered" }
  | { status: "busy" }
  | { status: "skipped"; reason: string };

/** Whether this session is in the middle of a turn right now. */
export async function isSessionRunning(sessionId: string): Promise<boolean> {
  const running = (await sessionRuntime()).getRpcSession(sessionId);
  return Boolean(running?.isAlive() && running.isRunning());
}

export async function wakeSession(sessionId: string, text: string): Promise<DeliveryOutcome> {
  let sessionFile: string | null;
  try {
    sessionFile = await (await sessionReader()).resolveSessionPath(sessionId);
  } catch (error) {
    return { status: "skipped", reason: `读会话路径失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!sessionFile) {
    return { status: "skipped", reason: "会话不存在" };
  }

  const running = (await sessionRuntime()).getRpcSession(sessionId);
  if (running?.isAlive() && running.isRunning()) {
    // Not a skip any more: the caller keeps the batch and delivers it after the
    // current turn, once, with every event that arrived meanwhile.
    return { status: "busy" };
  }

  try {
    const { session } = await (await sessionRuntime()).startRpcSession(sessionId, sessionFile, undefined, {});
    await session.send({ type: "prompt", message: text });
    return { status: "delivered" };
  } catch (error) {
    return { status: "skipped", reason: `注入失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
