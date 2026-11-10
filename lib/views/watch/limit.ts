/**
 * The process-wide cap on simultaneous watch sessions.
 *
 * It is a resource gate for the machine, not a property of one project's views:
 * a value in `views.yaml` would be copied to five projects and drift into a
 * second truth. So it is an environment variable, read when the pump starts,
 * with a bounded range — and the default stays 2, exactly the behaviour before
 * this switch existed (SSR-000089【已知取舍】).
 *
 * The panel shows the *effective* number, never a literal 2: an operator who
 * raised the cap must not be told the queue is waiting for two slots when it is
 * waiting for three.
 */
export const WATCH_RUNS_ENV = "PI_WEB_MAX_WATCH_RUNS";
export const DEFAULT_WATCH_RUNS = 2;
/** Below 1 the pump would never dispatch; above 8 it stops being a gate. */
export const MIN_WATCH_RUNS = 1;
export const MAX_WATCH_RUNS = 8;

export interface WatchRunLimit {
  limit: number;
  /** `default` = the variable says nothing; `env` = it was set (and may have been clamped). */
  source: "default" | "env";
  /** Why the written value did not apply verbatim; null when it did. */
  note: string | null;
}

/**
 * The configured cap, clamped to [1, 8].
 *
 * Three outcomes, all of them safe:
 * - unset → 2, no note (the ordinary case);
 * - set but not a whole number (empty, `abc`, `3.5`) → 2, with a note saying so;
 * - set outside the range (`0`, `-1`, `99`) → the nearest bound, with a note.
 *
 * Never throws: a mistyped environment variable must not keep the pump from
 * starting.
 */
export function watchRunLimit(env: Record<string, string | undefined> = process.env): WatchRunLimit {
  const raw = env[WATCH_RUNS_ENV];
  if (raw === undefined) return { limit: DEFAULT_WATCH_RUNS, source: "default", note: null };

  const text = raw.trim();
  if (text === "") {
    return {
      limit: DEFAULT_WATCH_RUNS,
      source: "env",
      note: `${WATCH_RUNS_ENV} 是空值，回退默认 ${DEFAULT_WATCH_RUNS}`,
    };
  }

  const parsed = Number(text);
  if (!Number.isInteger(parsed)) {
    return {
      limit: DEFAULT_WATCH_RUNS,
      source: "env",
      note: `${WATCH_RUNS_ENV}="${raw}" 不是整数，回退默认 ${DEFAULT_WATCH_RUNS}`,
    };
  }

  const limit = Math.min(MAX_WATCH_RUNS, Math.max(MIN_WATCH_RUNS, parsed));
  return {
    limit,
    source: "env",
    note:
      limit === parsed
        ? null
        : `${WATCH_RUNS_ENV}="${raw}" 超出 ${MIN_WATCH_RUNS}~${MAX_WATCH_RUNS}，已夹取到 ${limit}`,
  };
}

/** The startup line: without it nobody can tell whether the setting took effect. */
export function describeWatchRunLimit(limit: WatchRunLimit): string {
  const source = limit.source === "default" ? "默认" : WATCH_RUNS_ENV;
  return `全局并发上限 = ${limit.limit}（${source}）${limit.note ? `；${limit.note}` : ""}`;
}

/** The effective cap right now — the one both the pump and the panel must use. */
export function maxConcurrentWatchRuns(
  env: Record<string, string | undefined> = process.env,
): number {
  return watchRunLimit(env).limit;
}
