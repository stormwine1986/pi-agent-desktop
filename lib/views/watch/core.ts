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
  | { ok: false; error: string; conflict?: boolean };

export interface WatchSessionHandle {
  sessionId: string;
  /** Resolves when the turn ends, however it ends. */
  done: Promise<void>;
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
  log(event: WatchLogEvent): void;
}

export type WatchLogEvent =
  | { type: "claimed"; view: string; key: string; runCwd: string; sessionId: string }
  | { type: "done"; view: string; key: string; state: string }
  | { type: "failed"; view: string; key: string; state: string; failures: number }
  | { type: "manual"; view: string; key: string; reason: "failures" | "timeout" }
  | { type: "conflict"; view: string; key: string }
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
 * How many times in a row this entity went `to → back` without anything else
 * happening in between.
 *
 * A successful attempt moves `to → <something else>` and resets the streak. The
 * caller adds one for the attempt that just failed, because its own `to → back`
 * has not been written yet.
 */
export function countConsecutiveFailures(
  states: readonly string[],
  claim: { to: string; back: string },
): number {
  let streak = 0;
  for (let index = 1; index < states.length; index += 1) {
    if (states[index - 1] !== claim.to) continue;
    streak = states[index] === claim.back ? streak + 1 : 0;
  }
  return streak;
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
