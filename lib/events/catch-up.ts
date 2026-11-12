/**
 * `gap` accounting (SSR-000097 M3 / AC-1 + AC-2).
 *
 * The channel reports `gap` when the server could not hand back everything that
 * happened while this process was away (`lib/events/connection.ts` reads
 * `reason` / `dropped` / `lastEventId` / `cursor` off the frame). Two different
 * things can be wrong, and pretending they are the same is how a silent drop
 * happens:
 *
 * - **the window was not replayed, but the server can be asked again** —
 *   `busy` (the replay token bucket was empty) and `unavailable` (the stream
 *   lookup failed) are transient: reconnecting with the *same* cursor asks the
 *   server for that window a second time, and that is a real catch-up, not a
 *   retry of a failure;
 * - **the window is gone** — `truncated` (the stream was trimmed) and
 *   `overflow` (more matched frames than the replay limit). Asking again
 *   returns the same truncated answer, so no amount of retrying recovers it.
 *   The only honest thing left is to say which stretch of time was not
 *   delivered (`GapNotice`) and show it in the panel.
 *
 * The cursor is the SSE `id` of the last event the server handed over: a Redis
 * stream id, `<publishedAtMs>-<seq>`. Its millisecond part is therefore the
 * publish time of the last event we did see, which is exactly the left edge of
 * the window that was not delivered.
 */

/** One stretch of time whose events were not delivered. */
export interface GapNotice {
  /** When this process learned about it (epoch ms). */
  at: number;
  /** The server's word: `busy` / `unavailable` / `truncated` / `overflow` / `unknown`. */
  reason: string;
  /** How many frames the server admits it could not hand back — a lower bound, not a total. */
  dropped: number | null;
  /** Publish time of the last event we did receive (the left edge of the window). */
  from: number | null;
  /** The feed's head cursor when the gap was written (the right edge of the window). */
  to: number | null;
  /** When a retry got the window back; `null` means it did not (yet). */
  recoveredAt: number | null;
}

const STREAM_ID = /^(\d+)-(\d+)$/;

/** `<ms>-<seq>` → `ms`; anything else → null (a cursor we cannot reason about). */
export function streamIdMs(id: string | null | undefined): number | null {
  if (!id) return null;
  const parsed = STREAM_ID.exec(id);
  if (!parsed) return null;
  const ms = Number(parsed[1]);
  return Number.isFinite(ms) ? ms : null;
}

/** Numeric comparison of two stream ids; unparsable / missing ids compare as equal. */
export function compareStreamIds(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0;
  const left = STREAM_ID.exec(a);
  const right = STREAM_ID.exec(b);
  if (!left || !right) return 0;
  const msDiff = Number(left[1]) - Number(right[1]);
  if (msDiff !== 0) return msDiff;
  return Number(left[2]) - Number(right[2]);
}

/**
 * Whether an event frame is *backfill*: it was published at or before the feed
 * cursor the server reported in `ready`, so it cannot have happened after this
 * connection came up — it is the replay of what we missed, not a live event.
 *
 * Comparing ids (not wall-clock timestamps) keeps this immune to clock skew
 * between the base server and this process.
 */
export function isBackfill(eventStreamId: string | null, readyCursor: string | null): boolean {
  if (!eventStreamId || !readyCursor) return false;
  return compareStreamIds(eventStreamId, readyCursor) <= 0;
}

/** A gap a retry can actually close: the server was throttled, or the lookup failed once. */
export function isRecoverableGap(reason: string | null | undefined): boolean {
  return reason === "busy" || reason === "unavailable";
}

export interface GapFrame {
  at: number;
  reason: string;
  dropped: number | null;
  /** The cursor we asked to resume from (`gap.lastEventId`). */
  lastEventId: string | null;
  /** The feed head at the moment of the gap (`gap.cursor`). */
  cursor: string | null;
}

/** The `gap` frame → the record the panel prints. */
export function gapNoticeFrom(frame: GapFrame): GapNotice {
  return {
    at: frame.at,
    reason: frame.reason || "unknown",
    dropped: typeof frame.dropped === "number" && frame.dropped >= 0 ? frame.dropped : null,
    from: streamIdMs(frame.lastEventId),
    to: streamIdMs(frame.cursor) ?? frame.at,
    recoveredAt: null,
  };
}

function clockOf(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The sentence the panel prints (and the status API returns as `gap.copy`).
 *
 * It is the *only* place that is allowed to describe a gap, including the
 * unrecovered case: "在这段时间里确实没有叫醒你" is a fact the person can act
 * on (re-read the entities they care about), while a silent skip is not.
 */
export function describeGap(notice: GapNotice): string {
  // A cursor older than the retained stream is a real case (an app that was
  // closed for a week), and printing 1970 would read as a bug rather than as
  // "the server no longer has that history". Say which of the two it is.
  const staleFrom = notice.from === null
    || (notice.to !== null && notice.to - notice.from > 7 * 24 * 3600_000);
  const window = staleFrom
    ? notice.to === null
      ? "断线期间"
      : `早于服务端保留窗口：回放到的最后时刻 ${clockOf(notice.to)}，更早的`
    : notice.to !== null
      ? `${clockOf(notice.from!)}–${clockOf(notice.to)} 这段时间的`
      : `${clockOf(notice.from!)} 之后的`;
  const recovered = notice.recoveredAt !== null
    ? `（重连后已补投：${clockOf(notice.recoveredAt)} 取回该窗口）`
    : "";
  // A zero the *overflow* path leaves behind means "not counted", not "none":
  // only a positive number is a count the panel may print.
  const count = notice.dropped !== null && notice.dropped > 0
    ? `至少 ${notice.dropped} 条`
    : "条数无法统计";
  return `gap：${window}事件确实没有叫醒你（${notice.reason}，${count}）${recovered}`;
}

/** Whether a persisted `gap` entry is a real record (a state file can be hand-edited). */
export function readGapNotice(raw: unknown): GapNotice | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const at = number(record.at);
  if (at === null) return null;
  return {
    at,
    reason: typeof record.reason === "string" && record.reason ? record.reason : "unknown",
    dropped: number(record.dropped),
    from: number(record.from),
    to: number(record.to),
    recoveredAt: number(record.recoveredAt),
  };
}
