import { getRpcSession, startRpcSession } from "../rpc-manager";
import { resolveSessionPath } from "../session-reader";

/**
 * `action: wake` — inject a prompt into an existing session so it runs a turn.
 *
 * The lifecycle rules this follows (SSR-000097【反应与投递】, M1 subset):
 * - the session must exist; a subscription whose `sessionId` is not on disk is
 *   reported, never created (`ifNotRunning` does not create anything);
 * - a session that exists but is not loaded is *resumed*: same id, same file;
 * - a session that is running is not interrupted. M1 records the batch as
 *   skipped — `pendingBatch` (deliver after the current turn) is M2.
 *
 * Delivery is serialized per session by the caller (`runtime.ts`), so two
 * batches never enter one session at the same time.
 */

export type DeliveryOutcome =
  | { status: "delivered" }
  | { status: "skipped"; reason: string };

export async function wakeSession(sessionId: string, text: string): Promise<DeliveryOutcome> {
  let sessionFile: string | null;
  try {
    sessionFile = await resolveSessionPath(sessionId);
  } catch (error) {
    return { status: "skipped", reason: `读会话路径失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!sessionFile) {
    return { status: "skipped", reason: "会话不存在" };
  }

  const running = getRpcSession(sessionId);
  if (running?.isAlive() && running.isRunning()) {
    return { status: "skipped", reason: "会话正在跑这一轮，忙时排队属 M2，本次未注入" };
  }

  try {
    const { session } = await startRpcSession(sessionId, sessionFile, undefined, {});
    await session.send({ type: "prompt", message: text });
    return { status: "delivered" };
  } catch (error) {
    return { status: "skipped", reason: `注入失败：${error instanceof Error ? error.message : String(error)}` };
  }
}
