import type { EventRecord } from "./store";

/**
 * What a new task is asked to do.
 *
 * The event payload is the instruction the task starts from; a `prompt` in
 * subscriptions.yaml, when present, is prepended as extra context. Kept as a
 * pure function so the exact shape can be asserted in tests.
 */
export function buildTaskPrompt(event: EventRecord, extraPrompt: string): string {
  let payload: string;
  try {
    payload = JSON.stringify(event.data, null, 2);
  } catch {
    payload = String(event.data);
  }
  const extra = extraPrompt.trim();
  return extra ? `${extra}\n\n${payload}` : payload;
}

/** Readable session title: the business key when the event has one. */
export function buildTaskTitle(event: EventRecord): string {
  const key = event.key ?? event.eventId ?? event.eventType;
  return `${event.source} · ${key}`.slice(0, 80);
}

export type TaskDecision = "start" | "skip-running" | "skip-cooldown" | "ignore";

/**
 * At most one task per source at a time, and at most one every `cooldownMs`.
 *
 * A replayed stream (cursor lost, or a server that ignores `Last-Event-ID`) can
 * deliver a whole history in one batch. Turning that batch into a batch of
 * sessions would cost real money, so extra events are recorded and counted as
 * skipped instead — never dropped, they stay in the list.
 */
export function shouldStartTask(input: {
  action: EventRecord["action"];
  taskRunning: boolean;
  lastStartedAt: number | null;
  now: number;
  cooldownMs: number;
}): TaskDecision {
  if (input.action !== "new-task") return "ignore";
  if (input.taskRunning) return "skip-running";
  if (input.lastStartedAt !== null && input.now - input.lastStartedAt < input.cooldownMs) {
    return "skip-cooldown";
  }
  return "start";
}
