import { parseSseEvents } from "../sse-events";
import {
  readSubscriptionConfig,
  streamUrlWithCid,
  type SubscriptionAction,
  type SubscriptionSource,
} from "./config";
import { compileFilter, type CompiledFilter } from "./filter";
import { extractEventColumns } from "./event-fields";
import { buildTaskPrompt, buildTaskTitle, shouldStartTask } from "./task-prompt";
import { startSubscriptionTask } from "./tasks";
import {
  appendEventRecords,
  readCursor,
  readEventRecords,
  readUnreadCount,
  writeCursor,
  type EventRecord,
} from "./store";

/**
 * One long-lived SSE connection per source, one runner per workspace.
 *
 * The runner lives in the server process, not in the page: closing the tab must
 * not stop collection, and a restart must not lose the events already written
 * to the JSONL log. It reconnects with `Last-Event-ID` so a restart continues
 * from the last recorded event instead of starting over.
 */
export type SourceConnectionState = "connecting" | "live" | "retrying" | "stopped";

export interface SourceStatus {
  name: string;
  url: string;
  types: string[];
  entityTypes: string[];
  workspaceId: string | null;
  action: SubscriptionAction;
  filter: string;
  filterError: string | null;
  connection: SourceConnectionState;
  lastEventAt: string | null;
  lastError: string | null;
  eventCount: number;
  /** A task started by this source is still being spawned. */
  taskRunning: boolean;
  lastTaskAt: string | null;
  lastTaskSessionId: string | null;
  lastTaskError: string | null;
  /** Events that asked for a task while one was running or cooling down. */
  skippedTasks: number;
}

export interface SubscriptionsSnapshot {
  cwd: string;
  configPath: string;
  configExists: boolean;
  configError: string | null;
  sources: SourceStatus[];
  events: EventRecord[];
}

/** See shouldStartTask: bursts (a replayed stream) must not become bursts of sessions. */
const TASK_COOLDOWN_MS = 10_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONFIG_RECHECK_MS = 30_000;
const MAX_BATCH = 50;

type Listener = (event: EventRecord) => void;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Query parameters the yaml declares, read back for the list's columns. */
function splitParam(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function sourceStatusKey(source: SubscriptionSource): string {
  return JSON.stringify([source.name, source.url, source.filter, source.action, source.apiKey, source.headers]);
}

interface SourceTask {
  key: string;
  source: SubscriptionSource;
  status: SourceStatus;
  controller: AbortController;
  /** Epoch ms of the last task spawn, for the per-source cooldown. */
  lastTaskStartedAt: number | null;
}

const globalRegistry = globalThis as typeof globalThis & {
  __piWebSubscriptionRunners?: Map<string, WorkspaceRunner>;
};

class WorkspaceRunner {
  readonly cwd: string;
  private tasks = new Map<string, SourceTask>();
  private listeners = new Set<Listener>();
  private configError: string | null = null;
  private configPath: string;
  private configExists = false;
  private recheckTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.configPath = "";
    this.reconcile();
    this.recheckTimer = setInterval(() => this.reconcile(), CONFIG_RECHECK_MS);
    // Node keeps the process alive for timers; this one must not.
    this.recheckTimer.unref?.();
  }

  private reconcile(): void {
    if (this.stopped) return;
    const config = readSubscriptionConfig(this.cwd);
    this.configPath = config.path;
    this.configExists = config.exists;
    this.configError = config.error;

    const wanted = new Map<string, SubscriptionSource>();
    for (const source of config.sources) wanted.set(sourceStatusKey(source), source);

    // Drop sources that disappeared or whose definition changed.
    for (const [key, task] of this.tasks) {
      if (wanted.has(key)) continue;
      task.controller.abort();
      this.tasks.delete(key);
    }

    for (const [key, source] of wanted) {
      if (this.tasks.has(key)) continue;
      const compiled = compileFilter(source.filter);
      const status: SourceStatus = {
        name: source.name,
        url: source.url,
        types: splitParam(source.params.types),
        entityTypes: splitParam(source.params.entityTypes),
        workspaceId: source.params.workspaceId ?? null,
        action: source.action,
        filter: source.filter,
        filterError: compiled.ok ? null : compiled.error,
        connection: "connecting",
        lastEventAt: null,
        lastError: null,
        eventCount: 0,
        taskRunning: false,
        lastTaskAt: null,
        lastTaskSessionId: null,
        lastTaskError: null,
        skippedTasks: 0,
      };
      const controller = new AbortController();
      const task: SourceTask = { key, source, status, controller, lastTaskStartedAt: null };
      this.tasks.set(key, task);
      void this.runSource(task, compiled.ok ? compiled.filter : null);
    }
  }

  private async runSource(task: SourceTask, filter: CompiledFilter | null): Promise<void> {
    const { source, status, controller } = task;
    // A filter that does not parse stops the source instead of silently
    // accepting everything; the page shows the parser's message.
    if (!filter) {
      status.connection = "stopped";
      return;
    }

    let attempt = 0;
    while (!controller.signal.aborted && !this.stopped) {
      status.connection = attempt === 0 ? "connecting" : "retrying";
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        ...source.headers,
      };
      if (source.apiKey) headers.Authorization = `Bearer ${source.apiKey}`;
      const cursor = readCursor(this.cwd, source.name);
      if (cursor) headers["Last-Event-ID"] = cursor;

      try {
        // `cid` lets the channel supersede this source's own stale connection
        // after a crash or restart, instead of delivering its events twice.
        const response = await fetch(streamUrlWithCid(source.url, this.cwd, source.name), {
          headers,
          signal: controller.signal,
          cache: "no-store",
          redirect: "follow",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().includes("text/event-stream")) {
          throw new Error(`not an event stream (${contentType || "no content-type"})`);
        }
        status.connection = "live";
        status.lastError = null;
        attempt = 0;
        await this.consume(response, task, filter);
      } catch (error) {
        if (controller.signal.aborted) break;
        status.lastError = error instanceof Error ? error.message : String(error);
      }

      if (controller.signal.aborted) break;
      status.connection = "retrying";
      attempt += 1;
      await sleep(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5)), controller.signal);
    }
    status.connection = "stopped";
  }

  private async consume(response: Response, task: SourceTask, compiledFilter: CompiledFilter | null): Promise<void> {    const { source, status } = task;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (!task.controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      if (parsed.events.length === 0) continue;

      const pending: Omit<EventRecord, "seq">[] = [];
      let lastEventId: string | null = null;
      // Flush at the batch size instead of `break`-ing: a burst larger than
      // MAX_BATCH must not drop the events after the first batch.
      const flush = () => {
        if (pending.length === 0) return;
        const written = appendEventRecords(pending.splice(0, pending.length));
        status.eventCount += written.length;
        status.lastEventAt = written[written.length - 1]?.receivedAt ?? status.lastEventAt;
        for (const record of written) {
          for (const listener of this.listeners) {
            try {
              listener(record);
            } catch {
              // A broken consumer must not stop collection.
            }
          }
        }
        for (const record of written) this.maybeStartTask(task, record);
      };

      for (const event of parsed.events) {
        if (event.id) lastEventId = event.id;
        // Contract-level control frames from the entity-events channel.
        if (event.event === "ready") continue;
        if (event.event === "bye") {
          status.lastError = "服务端关闭了连接";
          continue;
        }
        if (event.event === "gap") {
          status.lastError = `事件流有缺口（${event.data.slice(0, 120)}）`;
          continue;
        }
        const record = this.toRecord(source, event.event, event.id, event.data, compiledFilter);
        if (record) pending.push(record);
        if (pending.length >= MAX_BATCH) flush();
      }

      flush();
      if (lastEventId) writeCursor(this.cwd, source.name, lastEventId);
    }
  }

  /**
   * `action: new-task` turns the event into a session in this workspace. Fire
   * and forget: the session runs on its own and appears on the Tasks page.
   */
  private maybeStartTask(task: SourceTask, record: EventRecord): void {
    const decision = shouldStartTask({
      action: record.action,
      taskRunning: task.status.taskRunning,
      lastStartedAt: task.lastTaskStartedAt,
      now: Date.now(),
      cooldownMs: TASK_COOLDOWN_MS,
    });
    if (decision === "ignore") return;
    if (decision !== "start") {
      task.status.skippedTasks += 1;
      return;
    }

    task.status.taskRunning = true;
    task.status.lastTaskError = null;
    task.lastTaskStartedAt = Date.now();
    void startSubscriptionTask({
      cwd: this.cwd,
      title: buildTaskTitle(record),
      prompt: buildTaskPrompt(record, task.source.prompt),
    })
      .then((result) => {
        if ("error" in result) {
          task.status.lastTaskError = result.error;
          return;
        }
        task.status.lastTaskSessionId = result.sessionId;
        task.status.lastTaskAt = new Date().toISOString();
      })
      .catch((error) => {
        task.status.lastTaskError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        task.status.taskRunning = false;
      });
  }

  private toRecord(
    source: SubscriptionSource,
    eventName: string | null,
    sseId: string | null,
    raw: string,
    filter: { test(value: unknown): boolean } | null,
  ): Omit<EventRecord, "seq"> | null {
    let data: unknown = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      // A non-JSON payload still counts as an event; it just has no columns.
    }
    if (filter && !filter.test(data)) return null;

    const columns = extractEventColumns(data, {
      eventName,
      sseId,
      workspaceIdParam: source.params.workspaceId ?? null,
    });

    return {
      receivedAt: new Date().toISOString(),
      cwd: this.cwd,
      source: source.name,
      eventType: columns.eventType,
      entityType: columns.entityType,
      workspaceId: columns.workspaceId,
      state: columns.state,
      key: columns.key,
      action: source.action,
      eventId: columns.eventId,
      data,
    };
  }

  addListener(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(limit: number): SubscriptionsSnapshot {
    return {
      cwd: this.cwd,
      configPath: this.configPath,
      configExists: this.configExists,
      configError: this.configError,
      sources: [...this.tasks.values()].map((task) => task.status),
      events: readEventRecords({ cwd: this.cwd, limit }),
    };
  }

  sourceStates(): { name: string; connection: SourceConnectionState }[] {
    return [...this.tasks.values()].map((task) => ({ name: task.source.name, connection: task.status.connection }));
  }

  stop(): void {
    this.stopped = true;
    if (this.recheckTimer) clearInterval(this.recheckTimer);
    for (const task of this.tasks.values()) task.controller.abort();
    this.tasks.clear();
    this.listeners.clear();
  }
}

function registry(): Map<string, WorkspaceRunner> {
  if (!globalRegistry.__piWebSubscriptionRunners) {
    globalRegistry.__piWebSubscriptionRunners = new Map();
  }
  return globalRegistry.__piWebSubscriptionRunners;
}

/** Starts collecting for `cwd` if nothing is running for it yet. */
export function ensureRunner(cwd: string): WorkspaceRunner {
  const runners = registry();
  const existing = runners.get(cwd);
  if (existing) return existing;
  const runner = new WorkspaceRunner(cwd);
  runners.set(cwd, runner);
  return runner;
}

export function getSubscriptionsSnapshot(cwd: string, limit = 200): SubscriptionsSnapshot {
  return ensureRunner(cwd).snapshot(limit);
}

export function subscribeToWorkspaceEvents(cwd: string, listener: Listener): () => void {
  return ensureRunner(cwd).addListener(listener);
}

export interface SubscriptionsStatus {
  cwd: string;
  /** Events recorded but not yet shown on the Subscriptions page. */
  unread: number;
  /** Whether a collector is running for this workspace right now. */
  running: boolean;
  sources: { name: string; connection: SourceConnectionState }[];
}

/**
 * Read-only: the sidebar polls this to know when to light the Subscriptions
 * dot, so it must not start a collector or read the event log.
 */
export function getSubscriptionsStatus(cwd: string): SubscriptionsStatus {
  const runner = registry().get(cwd);
  return {
    cwd,
    unread: readUnreadCount(cwd),
    running: Boolean(runner),
    sources: runner?.sourceStates() ?? [],
  };
}

export function stopRunner(cwd: string): void {
  const runners = registry();
  runners.get(cwd)?.stop();
  runners.delete(cwd);
}
