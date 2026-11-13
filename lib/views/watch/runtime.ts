import { agentDir as resolveAgentDir } from "../../agent-dir";
import { callMcpTool, resolveMcpTarget, type McpHttpTarget } from "../../mcp-call";
// SDK-free on purpose: this module is reached from the pump's first round, and
// `lib/rpc-manager` re-exports the same function after loading the whole agent
// runtime (DEFECT-000104). `lib/session-registry` reads the wrappers rpc-manager
// owns through a structural view, so the gate costs no module load at all.
import { hasBusyRpcSessionForCwd } from "../../session-registry";
import { classifyPromotionFailure } from "./core";
import { describeWatchRunLimit } from "./limit";
import type { WatchDeps, WatchResult, WatchRow, WatchSessionHandle, WatchTarget } from "./core";

/**
 * The live wiring: MCP tools for the data side, an in-process agent session for
 * the execution side. Both are reached here and nowhere else, so the pump itself
 * stays testable with stubs.
 */

function toRow(raw: unknown): WatchRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const key = record.key === undefined || record.key === null ? "" : String(record.key);
  if (!key) return null;
  return {
    id: record.id === undefined || record.id === null ? "" : String(record.id),
    key,
    type: typeof record.type === "string" ? record.type : "",
    state: typeof record.state === "string" ? record.state : "",
    revision: typeof record.revision === "number" ? record.revision : 0,
    modifiedAt: typeof record.modifiedAt === "string" ? record.modifiedAt : null,
    fields:
      typeof record.fields === "object" && record.fields !== null
        ? (record.fields as Record<string, unknown>)
        : {},
  };
}

function targetOf(agentDir: string, target: WatchTarget): { ok: true; value: McpHttpTarget } | { ok: false; error: string } {
  const resolved = resolveMcpTarget(agentDir, target.panelCwd, target.server);
  return resolved.ok ? { ok: true, value: resolved.target } : { ok: false, error: resolved.error };
}

export function createLiveDeps(): WatchDeps {
  const agentDir = resolveAgentDir();

  return {
    now: () => Date.now(),

    async list(target, query, options) {
      const resolved = targetOf(agentDir, target);
      if (!resolved.ok) return resolved;
      const result = await callMcpTool(resolved.value, "list", {
        workspaceId: target.workspace,
        query,
        limit: options.limit,
        offset: 0,
        ...(options.orderBy ? { orderBy: options.orderBy } : {}),
        ...(options.order ? { order: options.order } : {}),
      });
      if (!result.ok) return { ok: false, error: result.error };
      const payload = result.value as { items?: unknown } | undefined;
      const items = Array.isArray(payload?.items) ? payload.items : [];
      const rows: WatchRow[] = [];
      for (const item of items) {
        const row = toRow(item);
        if (row) rows.push(row);
      }
      return { ok: true, value: rows };
    },

    async get(target, key) {
      const resolved = targetOf(agentDir, target);
      if (!resolved.ok) return resolved;
      const result = await callMcpTool(resolved.value, "get", { id: key });
      if (!result.ok) return { ok: false, error: result.error };
      const row = toRow(result.value);
      return row ? { ok: true, value: row } : { ok: false, error: `get 返回的不是实体：${key}` };
    },

    async states(target, key) {
      const resolved = targetOf(agentDir, target);
      if (!resolved.ok) return resolved;
      const result = await callMcpTool(resolved.value, "list_revisions", { id: key });
      if (!result.ok) return { ok: false, error: result.error };
      const revisions = Array.isArray(result.value) ? result.value : [];
      const ordered = revisions
        .map((item) => toRow(item))
        .filter((row): row is WatchRow => row !== null)
        .sort((left, right) => left.revision - right.revision);
      return { ok: true, value: ordered.map((row) => row.state) };
    },

    async promote(target, key, to, expectedRevision) {
      const resolved = targetOf(agentDir, target);
      if (!resolved.ok) return resolved;
      const result = await callMcpTool(resolved.value, "promotion", {
        id: key,
        targetState: to,
        expectedRevision,
        idempotencyKey: `watch-${key}-${to}-${expectedRevision}-${crypto.randomUUID()}`,
      });
      if (!result.ok) {
        // One classification for every failed claim, so the pump cannot turn a
        // business refusal (a guard whose dependency is not done) into a red dot
        // that repeats every round (TASK-000054).
        const verdict = classifyPromotionFailure(result.error, result.structured);
        if (verdict.kind === "conflict") return { ok: false, error: result.error, conflict: true };
        if (verdict.kind === "skip") {
          return { ok: false, error: result.error, skip: { code: verdict.code, reason: verdict.reason } };
        }
        return { ok: false, error: result.error };
      }
      return { ok: true, value: null };
    },

    async metadata(target, type) {
      const resolved = targetOf(agentDir, target);
      if (!resolved.ok) return resolved;
      const result = await callMcpTool(resolved.value, "get_metadata", { type });
      if (!result.ok) return { ok: false, error: result.error };
      const payload = result.value as
        | { lifecycle?: { validStates?: unknown; routes?: unknown } }
        | undefined;
      const validStates = Array.isArray(payload?.lifecycle?.validStates)
        ? payload.lifecycle.validStates.filter((item): item is string => typeof item === "string")
        : [];
      const routes = Array.isArray(payload?.lifecycle?.routes)
        ? (payload.lifecycle.routes as unknown[])
            .map((route) => {
              if (typeof route !== "object" || route === null) return null;
              const record = route as Record<string, unknown>;
              return typeof record.from === "string" && typeof record.to === "string"
                ? { from: record.from, to: record.to }
                : null;
            })
            .filter((route): route is { from: string; to: string } => route !== null)
        : [];
      return { ok: true, value: { validStates, routes } };
    },

    async startSession(runCwd, prompt, title) {
      const handle = await startWatchSession(runCwd, prompt, title);
      return handle;
    },

    async projectBusy(runCwd) {
      // The app's own registry, not this pump's map: a resumed or continued human
      // session in the target project closes the gate the same way ours does.
      // Terminal processes never appear here — that is the agreed boundary.
      //
      // Read from the SDK-free registry, never from `rpc-manager`: the gate is
      // asked on *every* view of *every* project before any dispatch, and pulling
      // the agent runtime in here charged the first screen a 2.8–3.1 s event-loop
      // block even when the queue was empty (DEFECT-000104 / TASK-000214).
      return hasBusyRpcSessionForCwd(runCwd);
    },

    async count(target, query) {
      const resolved = targetOf(agentDir, target);
      if (!resolved.ok) return resolved;
      // One row is enough to decide; `includeTotal` is what makes the panel able
      // to say "有 N 条待人工" instead of silently rounding to one.
      const result = await callMcpTool(resolved.value, "list", {
        workspaceId: target.workspace,
        query,
        limit: 1,
        offset: 0,
        includeTotal: true,
      });
      if (!result.ok) return { ok: false, error: result.error };
      const payload = result.value as { total?: unknown; items?: unknown } | undefined;
      if (typeof payload?.total === "number") return { ok: true, value: payload.total };
      const items = Array.isArray(payload?.items) ? payload.items.length : 0;
      return { ok: true, value: items };
    },

    log(event) {
      // The startup line is the one event an operator has to be able to read in
      // the dev-server / journalctl output: it is the only confirmation that
      // `PI_WEB_MAX_WATCH_RUNS` took effect (or was clamped).
      if (event.type === "limit") {
        console.log("[watch]", describeWatchRunLimit(event));
        return;
      }
      // One line per state transition keeps `journalctl`/dev-server output useful
      // without inventing a log format the app has to maintain.
      console.log("[watch]", JSON.stringify(event));
    },
  };
}

/**
 * One session start at a time, process-wide.
 *
 * Creating an `AgentSession` is the most expensive thing this process does: the
 * pi SDK's module graph, the model runtime, the extension list and the MCP host
 * all come up on the main thread, and that cost may not be paid twice in
 * parallel. The pump's own loop visits views one after another, so today's
 * rounds already serialise — this is the guarantee rather than the observation:
 * the cap (`PI_WEB_MAX_WATCH_RUNS`) allows several sessions to be alive at once,
 * and any future caller that dispatches from two places must still find the
 * shared module load already paid by the first start.
 *
 * `serialized` keeps the chain alive after a failure: a view whose session could
 * not start must not block every later dispatch.
 */
let startQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const run = startQueue.then(work, work);
  // Keep the chain alive after a failure; the caller still sees its own error.
  startQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Starts a session in the executing project and resolves when its turn ends. */
async function startWatchSession(
  runCwd: string,
  prompt: string,
  title: string,
): Promise<WatchResult<WatchSessionHandle>> {
  return serialized(() => startWatchSessionNow(runCwd, prompt, title));
}

async function startWatchSessionNow(
  runCwd: string,
  prompt: string,
  title: string,
): Promise<WatchResult<WatchSessionHandle>> {
  const [{ startRpcSession }, { allowFileRoot }, { invalidateSessionListCache }] = await Promise.all([
    import("../../rpc-manager"),
    import("../../file-access"),
    import("../../session-reader"),
  ]);

  let session: Awaited<ReturnType<typeof startRpcSession>>;
  try {
    session = await startRpcSession(`__watch__${crypto.randomUUID()}`, "", runCwd, {
      allowInitialModelFallback: true,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  allowFileRoot(runCwd);
  invalidateSessionListCache();

  const wrapper = session.session;
  await wrapper.send({ type: "set_session_name", name: title }).catch(() => undefined);

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const unsubscribe = wrapper.onEvent((event) => {
    if (event.type === "prompt_done" || event.type === "prompt_error") resolveDone();
  });

  // `send` resolves when the prompt is admitted; the turn ends with prompt_done.
  void wrapper
    .send({ type: "prompt", message: prompt })
    .catch(() => resolveDone());

  return {
    ok: true,
    value: {
      sessionId: session.realSessionId,
      done: done.finally(() => unsubscribe()),
    },
  };
}
