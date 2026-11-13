/**
 * Pure pieces of the watch pump: how a view's DQL is sliced, how a failure
 * streak is read out of an entity's revision history, and how the prompt is
 * filled. Everything here is stateless so the rules can be tested without a
 * server, a session or a clock.
 */

export interface WatchRow {
  id: string;
  key: string;
  type: string;
  state: string;
  revision: number;
  modifiedAt: string | null;
  fields: Record<string, unknown>;
}

export interface WatchTarget {
  /** The project that owns views.yaml — where the data comes from. */
  panelCwd: string;
  server: string;
  workspace: string;
}

export type WatchResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      /** Another writer advanced the entity first — treat as "someone else has it". */
      conflict?: boolean;
      /**
       * A business refusal that means "not this round", not "the tool is broken":
       * the entity's own state does not allow the move yet (see
       * `classifyPromotionFailure`). `code` is for logs; `reason` is the sentence
       * the panel prints.
       */
      skip?: { code: string; reason: string };
    };

export interface WatchSessionHandle {
  sessionId: string;
  /** Resolves when the turn ends, however it ends. */
  done: Promise<void>;
}

/**
 * Why a view is not handing anything out this round.
 *
 * Every gate closes the whole view, not one row: a project stopped in the middle
 * of an attempt has to be looked at before new work is stacked on top of it
 * (andon semantics, SSR-000089 ④⑦). The third one is about the machine rather
 * than the project (the global concurrency cap), and it is named separately so
 * the three reasons cannot be mistaken for one another.
 */
export type WatchGate =
  | { reason: "session" }
  | { reason: "manual"; count: number }
  /**
   * The machine is already running as many watch sessions as it allows. It is a
   * third gate with its own sentence: an operator who sees "项目有运行中会话" for
   * a project that has none would go looking in the wrong place.
   */
  | { reason: "queue"; limit: number };

/** The sentence the panel prints — the same words the contract uses. */
export function describeGate(gate: WatchGate): string {
  if (gate.reason === "session") return "项目有运行中会话";
  if (gate.reason === "manual") return `有 ${gate.count} 条待人工`;
  // The effective cap, not a literal: raising it must change what this says.
  return `排队中：正在执行的任务已达上限（${gate.limit} 个）`;
}

export interface WatchDeps {
  now(): number;
  list(
    target: WatchTarget,
    query: string,
    options: { limit: number; orderBy?: string; order?: "asc" | "desc" },
  ): Promise<WatchResult<WatchRow[]>>;
  get(target: WatchTarget, key: string): Promise<WatchResult<WatchRow>>;
  /** States of every revision, oldest first — the only record of what already happened. */
  states(target: WatchTarget, key: string): Promise<WatchResult<string[]>>;
  promote(
    target: WatchTarget,
    key: string,
    to: string,
    expectedRevision: number,
  ): Promise<WatchResult<null>>;
  /** Type metadata, for the state-machine checks a view cannot answer on its own. */
  metadata(
    target: WatchTarget,
    type: string,
  ): Promise<WatchResult<{ validStates: string[]; routes: { from: string; to: string }[] }>>;
  startSession(runCwd: string, prompt: string, title: string): Promise<WatchResult<WatchSessionHandle>>;
  /**
   * True when the app itself has a running session in this directory.
   *
   * Read from the application's session registry (running ids + each session's
   * cwd), never from this pump's own bookkeeping: a manual resume or a continued
   * conversation counts too. Terminal processes are invisible on purpose.
   */
  projectBusy(runCwd: string): Promise<boolean>;
  /** Rows matching a query, used for the manual-state count behind the gate. */
  count(target: WatchTarget, query: string): Promise<WatchResult<number>>;
  log(event: WatchLogEvent): void;
}

export type WatchLogEvent =
  | { type: "claimed"; view: string; key: string; runCwd: string; sessionId: string }
  | { type: "done"; view: string; key: string; state: string }
  | { type: "manual"; view: string; key: string; reason: "failed" | "timeout" }
  | { type: "conflict"; view: string; key: string }
  | {
      type: "skipped";
      view: string;
      key?: string;
      reason: "session" | "manual" | "queue" | "policy";
      count?: number;
      limit?: number;
      /** The plain sentence for a policy skip; `code` is for logs only. */
      message?: string;
      code?: string;
    }
  | { type: "limit"; limit: number; source: "default" | "env"; note: string | null }
  /**
   * The pump's first round ran — and what it waited for (DEFECT-000104).
   *
   * Without this line an operator cannot tell "the pump is late because it waits
   * for a window" from "the pump is not running": the limit line above prints
   * before the wait, so a silent gap of a few seconds is otherwise unexplained.
   */
  | { type: "start"; view: string; after: "first-screen" | "fallback"; waitedMs: number; via?: string }
  | { type: "error"; view: string; key?: string; message: string };

/**
 * Rewrites the ONE `state = '<from>'` predicate into `state = '<to>'`, keeping
 * every other condition intact. That is what makes the claimed set belong to
 * this view and not to every other view of the same entity type.
 *
 * Nothing else is rewritten: `state in (...)`, `state != ...`, two state
 * predicates, or no state at all cannot be sliced, and the caller is expected to
 * refuse the view instead of guessing.
 */
export function sliceDql(dql: string, from: string, to: string): WatchResult<string> {
  const matches = [...dql.matchAll(/\bstate\s*=\s*(['"])([^'"]*)\1/gi)];
  if (matches.length === 0) {
    return { ok: false, error: `DQL 里没有 state = '<state>' 条件，无法切出认领态` };
  }
  if (matches.length > 1) {
    return { ok: false, error: `DQL 里有 ${matches.length} 个 state = 条件，无法确定要替换哪一个` };
  }
  const match = matches[0];
  const value = match[2] ?? "";
  if (value.toLowerCase() !== from.toLowerCase()) {
    return { ok: false, error: `DQL 里的 state 是 "${value}"，与 claim.from "${from}" 不一致` };
  }
  const start = match.index ?? 0;
  const quote = match[1];
  // Replace only the quoted value, so the operator's original spacing and quotes
  // survive: the query is the user's text, not ours to reformat.
  const quoted = `${quote}${value}${quote}`;
  const inner = match[0].indexOf(quoted);
  if (inner < 0) return { ok: false, error: `无法定位 DQL 里的 state 值："${value}"` };
  const valueStart = start + inner;
  const replaced = `${dql.slice(0, valueStart)}${quote}${to}${quote}${dql.slice(valueStart + quoted.length)}`;
  return { ok: true, value: replaced };
}

/**
 * How many times this entity has entered the claim state, counted from the
 * revision history.
 *
 * The dispatch is the attempt this count lands on, because the claim has
 * already been written by the time it is asked for. A person who moves an item
 * out of `manual` and back into the queue makes the next dispatch the second
 * attempt — nothing else can, since the pump never returns an item by itself.
 */
export function countClaims(states: readonly string[], claimedState: string): number {
  let count = 0;
  for (const state of states) {
    if (state === claimedState) count += 1;
  }
  return count;
}

/**
 * Promotion failures that mean "skip this row this round".
 *
 * Whitelist, not "any 4xx": `ENTITY_VALIDATION_FAILED` is a bad write that
 * retrying cannot fix, and a 404/401 is a broken target — both must stay errors
 * so the panel keeps showing a failure instead of a quiet wait. The three codes
 * below are the base's *business refusals* (entity-base `errors.ts`:
 * 「守卫拒绝是业务拒绝，不是系统错误——可以跳过该条、稍后重试」), always
 * `statusCode 409` + `retriable: false` + `skippedByPolicy: true`.
 */
export const SKIPPABLE_PROMOTION_CODES = [
  "STATE_GUARD_UNSATISFIED",
  "STATE_GUARD_BUDGET_EXCEEDED",
  "STATE_GUARD_CYCLE",
] as const;

export type PromotionVerdict =
  | { kind: "conflict" }
  | { kind: "skip"; code: string; reason: string }
  | { kind: "error" };

/** `Error executing tool 'promotion': [STATE_GUARD_CYCLE] …` → the code. */
function codeIn(error: string): string | null {
  const match = /\[([A-Z][A-Z0-9_]+)\]/.exec(error);
  return match ? match[1] : null;
}

function keysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const key = (item as { key?: unknown }).key;
    if (typeof key === "string" && key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The sentence for a policy skip. Plain words only — no `STATE_GUARD_*`, no
 * `claim`, no `intervalSec`: the panel is read by whoever works the queue, and
 * the first line has to say what to do next.
 */
export function describePromotionSkip(code: string, details?: Record<string, unknown> | null): string {
  if (code === "STATE_GUARD_UNSATISFIED") {
    const waiting = keysOf(details?.violations);
    return waiting.length > 0
      ? `条目依赖未完成（等待 ${waiting.join("、")}）`
      : "条目依赖未完成，稍后会自动重试";
  }
  if (code === "STATE_GUARD_BUDGET_EXCEEDED") {
    return "条目依赖链超出可检查范围，需要人调整依赖或拆分";
  }
  // STATE_GUARD_CYCLE: a data fact, not a transient state.
  return "条目依赖关系成环，需要人拆环";
}

/**
 * How a failed promotion should be recorded.
 *
 * Order matters: a concurrent-write conflict keeps its own `conflict` meaning
 * ("someone else owns the row, take the next one") and must not be swallowed by
 * the new skip branch, even when the server marks it retriable.
 *
 * With `structured` (the server's typed error body) the decision reads the
 * flags the base promises. A text-only error — an older server, or a stub — is
 * accepted when it carries a whitelisted code, because that code is itself the
 * contract; everything else stays an error.
 */
export function classifyPromotionFailure(
  error: string,
  structured?: Record<string, unknown> | null,
): PromotionVerdict {
  const code = typeof structured?.code === "string" ? structured.code : codeIn(error);
  if (code === "CONCURRENT_WRITE_CONFLICT" || /CONCURRENT_WRITE_CONFLICT/.test(error)) {
    return { kind: "conflict" };
  }
  if (!code || !(SKIPPABLE_PROMOTION_CODES as readonly string[]).includes(code)) {
    return { kind: "error" };
  }

  if (structured) {
    const statusCode = typeof structured.statusCode === "number" ? structured.statusCode : null;
    const retriable = typeof structured.retriable === "boolean" ? structured.retriable : null;
    const skippedByPolicy = structured.skippedByPolicy === true;
    const businessRefusal =
      skippedByPolicy || (retriable === false && statusCode !== null && statusCode >= 400 && statusCode < 500);
    if (!businessRefusal) return { kind: "error" };
  }

  const details = typeof structured?.details === "object" && structured.details !== null
    ? (structured.details as Record<string, unknown>)
    : null;
  return { kind: "skip", code, reason: describePromotionSkip(code, details) };
}

/** `{{name}}` substitution; unknown placeholders are left alone, so a typo is visible. */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole,
  );
}

/** One line per field, so a model reading the prompt sees the entity as it is. */
export function formatFields(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === "") continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`${name}: ${text}`);
  }
  return lines.length > 0 ? lines.join("\n") : "（无字段值）";
}
