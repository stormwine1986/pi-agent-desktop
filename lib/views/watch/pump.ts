import type { ViewDefinition, ViewWatch } from "../config";
import {
  countConsecutiveFailures,
  formatFields,
  renderPrompt,
  sliceDql,
  type WatchDeps,
  type WatchRow,
  type WatchTarget,
} from "./core";

/** How many watch sessions may run at once across every project. */
export const MAX_CONCURRENT_WATCH_RUNS = 2;

/** Rows fetched per scan; the API caps a page at 100 anyway. */
const SCAN_LIMIT = 100;

export interface RunningEntry {
  key: string;
  view: string;
  startedAt: number;
}

/**
 * What is running right now.
 *
 * Deliberately not persisted: the entity's claim state is the shared fact, this
 * map only answers "is this machine already working on that project". A restart
 * forgets it, which is correct — the sessions died with the process.
 */
export class WatchRegistry {
  private readonly byProject = new Map<string, RunningEntry>();

  get size(): number {
    return this.byProject.size;
  }

  get(project: string): RunningEntry | undefined {
    return this.byProject.get(project);
  }

  set(project: string, entry: RunningEntry): void {
    this.byProject.set(project, entry);
  }

  clear(project: string, key: string): void {
    if (this.byProject.get(project)?.key === key) this.byProject.delete(project);
  }
}

export interface PumpInput {
  view: ViewDefinition;
  watch: ViewWatch;
  target: WatchTarget;
}

export type PumpOutcome =
  | { status: "dispatched"; key: string; sessionId: string }
  | { status: "idle" }
  | { status: "busy"; reason: "project" | "global" }
  | { status: "error"; error: string };

/**
 * One pass for one view: hand claimed-but-stale items to the manual state, then
 * claim at most one pending item and start a session for it.
 *
 * Only dispatch is done here; the verdict is written later, when the session
 * ends (see `judge`). Polling never decides anything (SSR-000090 ③).
 */
export async function pumpView(
  input: PumpInput,
  deps: WatchDeps,
  registry: WatchRegistry,
): Promise<PumpOutcome> {
  const { view, watch, target } = input;
  const claim = watch.claim;

  // Aging first: an item that has been claimed far too long is not "waiting",
  // it is stuck, and the next dispatch must not race with that judgement.
  const claimed = await deps.list(target, sliceOrThrow(view.dql, claim.from, claim.to), {
    limit: SCAN_LIMIT,
    orderBy: "modified_at",
    order: "asc",
  });
  if (!claimed.ok) return { status: "error", error: claimed.error };
  await expireClaimed(input, claimed.value, deps);

  if (registry.get(watch.project)) return { status: "busy", reason: "project" };
  if (registry.size >= MAX_CONCURRENT_WATCH_RUNS) return { status: "busy", reason: "global" };

  const pending = await deps.list(target, view.dql, {
    limit: Math.min(view.pageSize, SCAN_LIMIT),
    orderBy: "modified_at",
    order: "asc",
  });
  if (!pending.ok) return { status: "error", error: pending.error };

  for (const row of pending.value) {
    // Claiming is the gate: whoever advances the state first owns the item, so a
    // second machine (or a second view) loses here instead of running twice.
    const claimedRow = await deps.promote(target, row.key, claim.to, row.revision);
    if (!claimedRow.ok) {
      if (claimedRow.conflict) {
        deps.log({ type: "conflict", view: view.title, key: row.key });
        continue;
      }
      return { status: "error", error: claimedRow.error };
    }
    const started = await dispatch(input, row, deps, registry);
    if (!started.ok) return { status: "error", error: started.error };
    return { status: "dispatched", key: row.key, sessionId: started.value };
  }

  return { status: "idle" };
}

/** Claimed rows that outlived `timeoutMin` are moved to the manual state. */
async function expireClaimed(input: PumpInput, rows: WatchRow[], deps: WatchDeps): Promise<void> {
  const { view, watch, target } = input;
  const limitMs = watch.timeoutMin * 60_000;
  const now = deps.now();
  for (const row of rows) {
    const since = row.modifiedAt ? Date.parse(row.modifiedAt) : Number.NaN;
    if (Number.isNaN(since) || now - since < limitMs) continue;
    const moved = await deps.promote(target, row.key, watch.claim.manual, row.revision);
    if (moved.ok) deps.log({ type: "manual", view: view.title, key: row.key, reason: "timeout" });
    else if (!moved.conflict) deps.log({ type: "error", view: view.title, key: row.key, message: moved.error });
  }
}

async function dispatch(
  input: PumpInput,
  row: WatchRow,
  deps: WatchDeps,
  registry: WatchRegistry,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const { view, watch, target } = input;
  const prompt = renderPrompt(await readPrompt(watch.prompt), {
    key: row.key,
    type: row.type,
    workspace: target.workspace,
    state: watch.claim.from,
    fields: formatFields(row.fields),
    runCwd: watch.project,
  });

  const started = await deps.startSession(
    watch.project,
    prompt,
    `${view.title} · ${row.key}`,
  );
  if (!started.ok) return { ok: false, error: started.error };

  registry.set(watch.project, { key: row.key, view: view.title, startedAt: deps.now() });
  const sessionId = started.value.sessionId;
  deps.log({ type: "claimed", view: view.title, key: row.key, runCwd: watch.project, sessionId });

  // The verdict is written when the turn ends, never on a tick.
  void judge(input, row.key, started.value.done, deps, registry);
  return { ok: true, value: sessionId };
}

/**
 * Reads the entity after the session ends.
 *
 * Still `claim.to` → the work did not land: hand it back for another attempt, or
 * park it once the streak is exhausted. Anything else → the executing project
 * already moved it, and this pump has nothing to add.
 */
async function judge(
  input: PumpInput,
  key: string,
  done: Promise<void>,
  deps: WatchDeps,
  registry: WatchRegistry,
): Promise<void> {
  const { view, watch, target } = input;
  const claim = watch.claim;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void parkAfterTimeout(input, key, deps);
  }, watch.timeoutMin * 60_000);
  // A waiting verdict must not keep the process (or a test runner) alive.
  timer.unref?.();

  try {
    await done;
  } finally {
    clearTimeout(timer);
    registry.clear(watch.project, key);
  }
  if (timedOut) return;

  const after = await deps.get(target, key);
  if (!after.ok) {
    deps.log({ type: "error", view: view.title, key, message: after.error });
    return;
  }
  if (after.value.state !== claim.to) {
    deps.log({ type: "done", view: view.title, key, state: after.value.state });
    return;
  }

  const history = await deps.states(target, key);
  // The attempt that just ended has not been written back yet, so it is added here.
  const failures = (history.ok ? countConsecutiveFailures(history.value, claim) : 0) + 1;
  const exhausted = failures >= watch.maxFailures;
  const next = exhausted ? claim.manual : claim.back;

  const moved = await deps.promote(target, key, next, after.value.revision);
  if (!moved.ok) {
    deps.log({ type: "error", view: view.title, key, message: moved.error });
    return;
  }
  if (exhausted) deps.log({ type: "manual", view: view.title, key, reason: "failures" });
  else deps.log({ type: "failed", view: view.title, key, state: after.value.state, failures });
}

/** The session overstayed `timeoutMin`: surface it, without killing anything. */
async function parkAfterTimeout(input: PumpInput, key: string, deps: WatchDeps): Promise<void> {
  const { view, watch, target } = input;
  const current = await deps.get(target, key);
  if (!current.ok || current.value.state !== watch.claim.to) return;
  const moved = await deps.promote(target, key, watch.claim.manual, current.value.revision);
  if (moved.ok) deps.log({ type: "manual", view: view.title, key, reason: "timeout" });
}

/** The sliced query is validated at load time; this is the same check, once more. */
function sliceOrThrow(dql: string, from: string, to: string): string {
  const sliced = sliceDql(dql, from, to);
  return sliced.ok ? sliced.value : dql;
}

const promptCache = new Map<string, { text: string; at: number }>();

/** Reads the prompt file, remembering it for a minute so a tick stays cheap. */
export async function readPrompt(path: string): Promise<string> {
  const cached = promptCache.get(path);
  const now = Date.now();
  if (cached && now - cached.at < 60_000) return cached.text;
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(path, "utf8");
  promptCache.set(path, { text, at: now });
  return text;
}
