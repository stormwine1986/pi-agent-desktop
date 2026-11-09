import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireLease, isPidAlive } from "../../scheduled-tasks/lease";
import { readViewsConfig, type ViewDefinition, type ViewWatch } from "../config";
import { describeGate, sliceDql } from "./core";
import { createLiveDeps } from "./runtime";
import { pumpView, WatchRegistry, readPrompt, MAX_CONCURRENT_WATCH_RUNS, type PumpOutcome } from "./pump";
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

export interface WatchPumpOptions {
  deps?: WatchDeps;
  /** Projects to scan; defaults to the ones the session list knows about. */
  projects?: () => Promise<string[]>;
  intervalMs?: number;
}

interface ViewState {
  lastRunAt: number;
  inFlight: boolean;
  /** Non-null when the view cannot be dispatched, with the reason to show. */
  disabled: string | null;
  /** Non-null when a dispatch gate closed this view in the last round. */
  skipped: string | null;
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
  /** Why the last round handed nothing out although the view is valid (④⑦). */
  skipped: string | null;
}

export function watchViewStatus(projectCwd: string, view: ViewDefinition): WatchViewStatus | null {
  const state = states.get(watchViewKey(projectCwd, view));
  return state ? { disabled: state.disabled, inFlight: state.inFlight, skipped: state.skipped } : null;
}

export function startWatchPump(options: WatchPumpOptions = {}): () => void {
  const deps = options.deps ?? createLiveDeps();
  const intervalMs = options.intervalMs ?? TICK_MS;
  const lockDir = join(getAgentDir(), "watch");
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    // A dev server and the desktop app both watch the same projects; only one of
    // them may dispatch, or every item would be claimed twice.
    if (!acquireLease(lockDir, { alive: isPidAlive })) return;
    try {
      const projects = options.projects ? await options.projects() : await visibleProjects();
      for (const project of projects) {
        if (stopped) return;
        await pumpProject(project, deps);
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

async function pumpProject(projectCwd: string, deps: WatchDeps): Promise<void> {
  const config = readViewsConfig(projectCwd);
  if (!config.exists || config.error) return;

  for (const entry of config.views) {
    const view = entry.view;
    const watch = view?.watch;
    if (!view || !watch) continue;
    if (!watch.enabled) continue;

    const key = watchViewKey(projectCwd, view);
    const state = states.get(key) ?? { lastRunAt: 0, inFlight: false, disabled: null, skipped: null, validatedAt: 0 };
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
        registry,
      );
      state.skipped = skipReasonOf(outcome);
      if (outcome.status === "error") {
        deps.log({ type: "error", view: view.title, message: outcome.error });
      }
    } finally {
      state.inFlight = false;
    }
  }
}

function skipReasonOf(outcome: PumpOutcome): string | null {
  if (outcome.status === "skipped") return describeGate(outcome.gate);
  if (outcome.status === "busy") {
    return outcome.reason === "project"
      ? describeGate({ reason: "session" })
      : `已达全局并发上限（${MAX_CONCURRENT_WATCH_RUNS} 个）`;
  }
  // dispatched / idle / error: no gate kept this round, so nothing to explain
  // (an error already has its own line in the panel).
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
