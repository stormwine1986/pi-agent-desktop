/**
 * 「依赖已失效」— read-side, computed every time the detail panel opens
 * (`SSR-000094` AC-11).
 *
 * The base guarantees a guard only at the moment a transition happens; a target
 * that moves out of the acceptable set afterwards leaves no mark anywhere
 * (`suspect` would be a second truth, and a stale one). So the panel recomputes
 * the answer from two reads it already has:
 *
 * - the relation rows and each target's current state (`list_traces`),
 * - the guarded routes of this type, with the guard's expected state set and the
 *   base's own human sentence (`get_metadata`).
 *
 * Nothing here writes: no entity, no link, no `suspect` flag. The engine still
 * owns the refusal — this is only the visible warning before it happens.
 */

export interface StateGuard {
  /** The relation the guard quantifies over, as this entity's side names it. */
  relation: string;
  /** The states a target may be in. Empty when the expression is not the shape read below. */
  expectedStates: string[];
  /** The base's own human sentence (`guard_description`), already free of the expression. */
  description: string;
  /** The state this guard governs, when the route stated one. */
  from: string;
}

export interface UpstreamRow {
  key: string;
  type?: string;
  name?: string;
  state: string;
  /** The relation as named by the side that owns the link — the name a guard uses. */
  linkType: string;
}

export interface StaleDependency {
  key: string;
  type: string;
  name: string;
  /** The target's state now, which is what makes this stale. */
  state: string;
  /** The states the violated guard accepts. */
  expectedStates: string[];
  /** The base's human sentence for the violated guard; the fallback wording when no set could be read. */
  description: string;
  /** Which relation is broken — kept for the React key, never rendered. */
  relation: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `'FINISHED'`, `"FINISHED"`, `FINISHED` — a state written inside `in [...]` or after `=`. */
function stateOf(raw: string): string {
  return raw.trim().replace(/^['"]|['"]$/g, "").trim();
}

function statesOf(list: string): string[] {
  return list
    .split(",")
    .map(stateOf)
    .filter((state) => state.length > 0);
}

/**
 * `all(<relation>, it.state <comparison>)` — the only guard shape read here.
 *
 * The engine's language is wider (`any`, `count`, combined expressions). This
 * function claims exactly the quantifier-over-target-state form, because that is
 * the one whose "needed states" can be stated as a set without guessing. Any
 * other expression stays silent rather than inventing a requirement.
 */
const ALL_TARGET_STATE = /\ball\s*\(\s*([A-Za-z_][\w]*)\s*,\s*it\.state\s+(?:in\s*\[([^\]]*)\]|={1,2}\s*(['"])([^'"]*)\3)\s*\)/g;

/** Reads the guards a type declares, from `get_metadata`'s `lifecycle.routes`. */
export function readStateGuards(lifecycle: unknown): StateGuard[] {
  const record = asRecord(lifecycle);
  const routes = Array.isArray(record?.routes)
    ? record.routes
    : Array.isArray(lifecycle)
      ? lifecycle
      : [];
  const guards: StateGuard[] = [];
  for (const entry of routes) {
    const route = asRecord(entry);
    const expression = text(route?.guard);
    if (!expression) continue;
    const description = text(route?.guard_description);
    const from = text(route?.from);
    for (const match of expression.matchAll(ALL_TARGET_STATE)) {
      const relation = stateOf(match[1] ?? "");
      if (!relation) continue;
      const expectedStates = match[2] !== undefined
        ? statesOf(match[2])
        : statesOf(match[4] ?? "");
      if (expectedStates.length === 0) continue;
      guards.push({ relation, expectedStates, description, from });
    }
  }
  return guards;
}

/**
 * The guards that can decide this target right now.
 *
 * A guard is declared on a route *from* a state: once the entity has left that
 * state the route is historical. So the guards of the current state come first;
 * a type that declares only guarded routes elsewhere still gets its dependency
 * checked, because "the target is no longer acceptable" must not be silent just
 * because no guarded route happens to start here (`AC-11`).
 */
function guardsFor(guards: StateGuard[], relation: string, state: string): StateGuard[] {
  const forRelation = guards.filter((guard) => guard.relation === relation);
  const current = forRelation.filter((guard) => !guard.from || guard.from === state);
  return current.length > 0 ? current : forRelation;
}

/**
 * Every upstream target that sits outside the states its relation's guard
 * accepts. No rows, no guard, or all targets acceptable → an empty list, so the
 * panel has nothing to show. Pure: same inputs, same answer, no request.
 */
export function staleDependencies(input: {
  state: string;
  lifecycle: unknown;
  /** Absent when the traces read failed or nothing is linked — either way, nothing to report. */
  upstream?: readonly UpstreamRow[];
}): StaleDependency[] {
  const guards = readStateGuards(input.lifecycle);
  if (guards.length === 0) return [];
  const state = text(input.state);
  const seen = new Set<string>();
  const stale: StaleDependency[] = [];
  for (const row of input.upstream ?? []) {
    const relation = text(row.linkType);
    if (!relation) continue;
    const violated = guardsFor(guards, relation, state)
      .find((guard) => !guard.expectedStates.includes(text(row.state)));
    if (!violated) continue;
    const id = `${relation}:${row.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    stale.push({
      key: text(row.key),
      type: text(row.type),
      name: text(row.name),
      state: text(row.state),
      expectedStates: violated.expectedStates,
      description: violated.description,
      relation,
    });
  }
  return stale;
}

/** What the target has to be in, in words: the state set when known, else the base's sentence. */
export function staleDependencyNeed(entry: StaleDependency): string {
  return entry.expectedStates.length > 0
    ? entry.expectedStates.join(" / ")
    : entry.description;
}

/**
 * One line of the notice, exactly as `AC-11` words it:
 * 「依赖已失效：TASK-000040 当前 DRAFT（需要 FINISHED / INVALID）」.
 *
 * The relation name, the guard expression and `it.state` never reach this text —
 * they mean nothing to a reader looking at a task.
 */
export function staleDependencyLine(entry: StaleDependency): string {
  const need = staleDependencyNeed(entry);
  const suffix = need ? `（需要 ${need}）` : "";
  return `依赖已失效：${entry.key} 当前 ${entry.state || "未知"}${suffix}`;
}
