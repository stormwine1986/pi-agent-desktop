import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireLease, isPidAlive } from "../../scheduled-tasks/lease";
import { readViewsConfig, type ViewDefinition, type ViewWatch } from "../config";
import { describeGate, sliceDql } from "./core";
import { watchRunLimit } from "./limit";
import { createLiveDeps } from "./runtime";
import { pumpView, WatchRegistry, readPrompt, type PumpOutcome } from "./pump";
import type { WatchDeps } from "./core";

/**
 * The dispatcher: every minute it looks at each project the app knows about,
 * picks up the views that asked to be watched, and hands one item at a time to
 * the configured project.
 *
 * Nothing here depends on a window being open. The packaged app keeps this
 * server alive while its window sits in the tray, so switching tabs, switching
 * apps or minimising the window changes nothing (SSR-000089 ①).
 */

const TICK_MS = 60_000;
const VALIDATION_TTL_MS = 60_000;

/**
 * The one placeholder a template cannot leave out.
 *
 * The prompt is whatever the template says: `renderPrompt` fills the
 * placeholders that appear in it and produces nothing for the ones that do not
 * (`core.ts`). A template without `{{key}}` therefore dispatches a session that
 * cannot tell which entity it owns, and the executor can only guess with a
 * `list` — the session title carries the key, but the model never sees its own
 * title (SSR-000089 ⑤, AC-12/AC-13). That is a configuration error, decided
 * here at load time, not a silent round.
 *
 * Every other placeholder stays optional: a template gives what it asks for.
 */
export const REQUIRED_PROMPT_PLACEHOLDER = "{{key}}";

export interface WatchPumpOptions {
  deps?: WatchDeps;
  /** Projects to scan; defaults to the ones the session list knows about. */
  projects?: () => Promise<string[]>;
  intervalMs?: number;
  /** The running-session map to consult; tests occupy slots with their own. */
  registry?: WatchRegistry;
}

interface ViewState {
  lastRunAt: number;
  inFlight: boolean;
  /** Non-null when the view cannot be dispatched, with the reason to show. */
  disabled: string | null;
  /**
   * The last round that had work and handed nothing out, with the reason.
   *
   * Sticky on purpose: a later round that finds an empty queue (`idle`) must not
   * wipe it, or two different facts — "the queue is empty" and "there was work
   * and it was held back" — end up as the same picture (SSR-000089【可观测】).
   * Cleared only by a successful dispatch or replaced by a new reason.
   */
  skipped: string | null;
  /** The last round looked and found nothing to hand out. */
  idle: boolean;
  /**
   * A session this very view dispatched is still running. Displayed as "正在派发",
   * never as the "项目有运行中会话" gate: that sentence answers "who is holding
   * this round back", and our own session is the work, not a hold-back.
   */
  ownRunning: boolean;
  /** A real failure (network, auth, 5xx, a non-policy 4xx) on the last round. */
  error: string | null;
  validatedAt: number;
}

const states = new Map<string, ViewState>();
const registry = new WatchRegistry();

export function watchViewKey(projectCwd: string, view: ViewDefinition): string {
  return `${projectCwd}::${view.title}`;
}

/** Exposed for the panel/tests: why a view is not dispatching. */
export function watchViewState(projectCwd: string, view: ViewDefinition): ViewState | undefined {
  return states.get(watchViewKey(projectCwd, view));
}

/**
 * What the panel needs to explain a silent view: a watched view that cannot
 * dispatch looks exactly like an empty queue otherwise.
 */
export interface WatchViewStatus {
  /** Why this view is not dispatching, or null when it is fine. */
  disabled: string | null;
  /** True while a session for this view is running. */
  inFlight: boolean;
  /** Why the last round with work handed nothing out (gates, queue, policy). */
  skipped: string | null;
  /** The last round looked and found nothing to hand out. */
  idle: boolean;
  /** A real failure on the last round, shown in the error tone. */
  error: string | null;
}

export function watchViewStatus(projectCwd: string, view: ViewDefinition): WatchViewStatus | null {
  const state = states.get(watchViewKey(projectCwd, view));
  return state
    ? {
        disabled: state.disabled,
        inFlight: state.inFlight || state.ownRunning,
        skipped: state.skipped,
        idle: state.idle,
        error: state.error,
      }
    : null;
}

export function startWatchPump(options: WatchPumpOptions = {}): () => void {
  const deps = options.deps ?? createLiveDeps();
  const intervalMs = options.intervalMs ?? TICK_MS;
  const running = options.registry ?? registry;
  const lockDir = join(getAgentDir(), "watch");
  let stopped = false;

  // The effective cap goes into the log at startup: a value that was clamped or
  // fell back to the default is otherwise invisible until the queue stalls.
  deps.log({ ...watchRunLimit(), type: "limit" });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // A dev server and the desktop app both watch the same projects; only one of
    // them may dispatch, or every item would be claimed twice.
    if (!acquireLease(lockDir, { alive: isPidAlive })) return;
    try {
      const projects = options.projects ? await options.projects() : await visibleProjects();
      for (const project of projects) {
        if (stopped) return;
        await pumpProject(project, deps, running);
      }
    } catch (error) {
      deps.log({ type: "error", view: "-", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Do not hold the event loop open just for the pump.
  timer.unref?.();
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function visibleProjects(): Promise<string[]> {
  const [{ listAllSessions }, { getRecentProjects }] = await Promise.all([
    import("../../session-reader"),
    import("../../project-groups"),
  ]);
  const sessions = await listAllSessions({ allowStale: true });
  return getRecentProjects(sessions).map((project) => project.root);
}

async function pumpProject(projectCwd: string, deps: WatchDeps, running: WatchRegistry): Promise<void> {
  const config = readViewsConfig(projectCwd);
  if (!config.exists || config.error) return;

  for (const entry of config.views) {
    const view = entry.view;
    const watch = view?.watch;
    if (!view || !watch) continue;
    if (!watch.enabled) continue;

    const key = watchViewKey(projectCwd, view);
    const state =
      states.get(key) ?? {
        lastRunAt: 0,
        inFlight: false,
        disabled: null,
        skipped: null,
        idle: false,
        ownRunning: false,
        error: null,
        validatedAt: 0,
      };
    states.set(key, state);
    if (state.inFlight) continue;
    // A view whose interval equals the tick period would otherwise be skipped
    // every other tick: the tick that lands 50ms early fails a strict `<`.
    const intervalMs = Math.max(0, watch.intervalSec * 1000 - 1_000);
    if (deps.now() - state.lastRunAt < intervalMs) continue;

    if (deps.now() - state.validatedAt > VALIDATION_TTL_MS) {
      state.disabled = await validate(projectCwd, view, watch, deps);
      state.validatedAt = deps.now();
    }
    if (state.disabled) continue;

    state.inFlight = true;
    state.lastRunAt = deps.now();
    try {
      const outcome: PumpOutcome = await pumpView(
        { view, watch, target: { panelCwd: projectCwd, server: view.server, workspace: view.workspace } },
        deps,
        running,
      );
      applyOutcome(state, outcome, view.title, deps);
    } finally {
      state.inFlight = false;
    }
  }
}

/**
 * Fold one round's outcome into what the panel shows.
 *
 * The three reasons are kept apart instead of collapsed into one field, because
 * they answer different questions:
 * - `idle` — nothing was waiting (the queue really is empty);
 * - `skipped` — there was (or may have been) work and it was held back; sticky
 *   across `idle`, so a held-back round stays visible instead of looking like a
 *   queue that was never full;
 * - `error` — a real failure. It never overwrites a skip reason and never gets
 *   overwritten by one; a successful dispatch clears both.
 */
function applyOutcome(state: ViewState, outcome: PumpOutcome, viewTitle: string, deps: WatchDeps): void {
  if (outcome.status === "dispatched") {
    state.skipped = null;
    state.idle = false;
    state.error = null;
    state.ownRunning = true;
    return;
  }
  if (outcome.status === "busy" && outcome.reason === "project" && outcome.own) {
    // This view's own session is running. Not a skip: nothing was held back, and
    // saying "项目有运行中会话" here would point at the wrong thing — the project
    // is busy with this very view.
    state.ownRunning = true;
    state.idle = false;
    state.error = null;
    return;
  }
  state.ownRunning = false;
  if (outcome.status === "idle") {
    // Nothing to explain, and nothing to erase either: this round proves the
    // queue is empty now, not that the last gate never closed.
    state.idle = true;
    state.error = null;
    return;
  }
  if (outcome.status === "error") {
    state.idle = false;
    state.error = outcome.error;
    deps.log({ type: "error", view: viewTitle, message: outcome.error });
    return;
  }
  // A gate, the global cap, or a business refusal: there was work (or we could
  // not look), and this round handed nothing out.
  state.skipped = skipReasonOf(outcome);
  state.idle = false;
  state.error = null;
}

function skipReasonOf(outcome: PumpOutcome): string | null {
  if (outcome.status === "skipped") return describeGate(outcome.gate);
  if (outcome.status === "busy") {
    // "global" carries the effective cap, so a raised limit says 3, not 2.
    return outcome.reason === "project"
      ? describeGate({ reason: "session" })
      : describeGate({ reason: "queue", limit: outcome.limit });
  }
  if (outcome.status === "policy") return outcome.reason;
  // dispatched / idle / error: nothing a gate held back (an error has its own
  // visible state, see `applyOutcome`).
  return null;
}

/**
 * Everything that can be decided before dispatching anything: files on disk, the
 * four states in the type's state machine, the routes between them, and the DQL
 * being sliceable.
 *
 * A view that fails here is *not* dispatched at all — half-configured dispatch
 * is worse than none, because it looks like the queue is simply empty.
 */
export async function validate(
  projectCwd: string,
  view: ViewDefinition,
  watch: ViewWatch,
  deps: WatchDeps,
): Promise<string | null> {
  if (!isDirectory(watch.project)) return `watch.project 不是目录：${watch.project}`;
  if (!existsSync(watch.prompt)) return `watch.prompt 不存在：${watch.prompt}`;
  try {
    const text = await readPrompt(watch.prompt);
    if (!text.trim()) return `watch.prompt 是空文件：${watch.prompt}`;
    // Same shape as every other configuration failure: the view is disabled
    // (AC-11 red dot) and the sentence names the file and the missing piece.
    if (!text.includes(REQUIRED_PROMPT_PLACEHOLDER)) {
      return `watch.prompt 模板缺 ${REQUIRED_PROMPT_PLACEHOLDER}，派发正文里将没有该条目的 key：${watch.prompt}（视图 "${view.title}"）`;
    }
  } catch (error) {
    return `watch.prompt 读不到：${error instanceof Error ? error.message : String(error)}`;
  }

  const sliced = sliceDql(view.dql, watch.claim.from, watch.claim.to);
  if (!sliced.ok) return `${sliced.error}（视图 "${view.title}"）`;

  if (watch.claim.manual === watch.claim.from) {
    return `watch.claim.manual 不能等于 from（${watch.claim.from}），否则待人工会被立刻重新派发（视图 "${view.title}"）`;
  }

  const type = extractType(view.dql);
  if (!type) return null; // No type in the DQL: state checks need metadata we cannot fetch.

  const metadata = await readStates(deps, { panelCwd: projectCwd, server: view.server, workspace: view.workspace }, type);
  if (!metadata.ok) return metadata.error;
  const { validStates, routes } = metadata.value;

  for (const [field, state] of [
    ["from", watch.claim.from],
    ["to", watch.claim.to],
    ["manual", watch.claim.manual],
  ] as const) {
    if (!validStates.includes(state)) {
      return `watch.claim.${field} = "${state}" 不是类型 ${type} 的状态（可用：${validStates.join(" / ")}）`;
    }
  }
  const missing: string[] = [];
  if (!routes.some((route) => route.from === watch.claim.from && route.to === watch.claim.to)) {
    missing.push(`${watch.claim.from} → ${watch.claim.to}`);
  }
  if (!routes.some((route) => route.from === watch.claim.to && route.to === watch.claim.manual)) {
    missing.push(`${watch.claim.to} → ${watch.claim.manual}`);
  }
  if (missing.length > 0) {
    return `类型 ${type} 缺少路由：${missing.join("、")}（视图 "${view.title}"）`;
  }
  return null;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `type = 'TASK'` — the only condition the state checks need. */
export function extractType(dql: string): string | null {
  const match = /\btype\s*=\s*(['"])([^'"]+)\1/i.exec(dql);
  return match ? match[2] : null;
}

async function readStates(
  deps: WatchDeps,
  target: { panelCwd: string; server: string; workspace: string },
  type: string,
): Promise<{ ok: true; value: { validStates: string[]; routes: { from: string; to: string }[] } } | { ok: false; error: string }> {
  const metadata = await deps.metadata?.(target, type);
  if (!metadata) return { ok: false, error: "无法读取类型元数据" };
  return metadata;
}
