/**
 * What a view's dispatch state looks like on the panel.
 *
 * SSR-000089 AC-11: four states have to be readable from the view list itself —
 * a watched view with nothing to hand out, a watched view that was skipped this
 * round, a view with no dispatch at all, and a view whose dispatch is broken.
 * Before this, three of the four looked identical (nothing on screen), so "the
 * queue is empty" and "the queue is switched off" were the same picture.
 *
 * The input is exactly the `watch` object `/api/views` already answers with:
 * there is no second flag for "is this view watched", and nothing here is
 * persisted. `null` is the unwatched view — that absence is the fourth state,
 * and it must stay an absence rather than become a grey dot (a grey dot would
 * read as "watched but idle", which is what green means).
 */
export interface WatchState {
  /** Why dispatch is off, or null when it is fine (SSR-000089 ⑥, AC-3/AC-5). */
  disabled: string | null;
  /** A session for this view is running right now. */
  inFlight: boolean;
  /**
   * Why the last round that had work handed nothing out (④⑦, the global cap, or a
   * business refusal). It survives a later round that finds an empty queue, so
   * "held back" never becomes "the queue was empty".
   */
  skipped: string | null;
  /** The last round looked and found nothing to hand out. */
  idle?: boolean;
  /** A real failure on the last round (network, auth, a non-policy 4xx). */
  error?: string | null;
}

export type WatchTone = "ready" | "skipped" | "error";

export interface WatchIndicator {
  tone: WatchTone;
  /** Name of the state; the dot's tooltip starts with this. */
  label: string;
  /** One line of why, in the words of whoever reads the queue. */
  detail: string;
}

/**
 * Configuration field → the words a person reading a to-do list uses.
 *
 * The reasons from the server are written for whoever edits `views.yaml`
 * ("watch.claim.manual 不能等于 from"); the panel is read by whoever works the
 * queue, so the field names are translated instead of shown. Longest names
 * first: `watch.claim.from` must not be eaten by a `watch.claim` rule.
 */
const FIELD_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/watch\.claim\.manual/g, "待人工状态"],
  [/watch\.claim\.from/g, "待处理状态"],
  [/watch\.claim\.to/g, "认领状态"],
  [/watch\.claim\.back/g, "归还状态"],
  [/watch\.project/g, "执行项目"],
  [/watch\.prompt/g, "任务说明文件"],
  [/watch\.enabled/g, "派发开关"],
  // Any other configuration key: still a reason, just not a field by name.
  [/watch\.[A-Za-z][\w.]*/g, "派发设置"],
];

/**
 * Sentences that only parse because the field name was in them: "执行项目 不是
 * 目录" is what the substitution above leaves behind, and "执行项目的目录不存在"
 * is what a person would say.
 */
const PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(\S+) 不是目录：/, "$1的目录不存在："],
  [/(\S) 不存在：/, "$1不存在："],
  [/ 是空文件：/, "是空的："],
];

/** A server reason, with configuration field names turned into plain words. */
export function plainReason(reason: string): string {
  let text = reason.trim();
  for (const [pattern, words] of FIELD_WORDS) text = text.replace(pattern, words);
  for (const [pattern, words] of PHRASES) text = text.replace(pattern, words);
  return text;
}

/**
 * The indicator for one view, or null when the view does not dispatch at all.
 *
 * Order matters: a disabled view that also carries a skip line from an older
 * round is *disabled* — that is the state the reader has to act on.
 */
export function watchIndicator(watch: WatchState | null | undefined): WatchIndicator | null {
  if (!watch) return null;
  if (watch.disabled) {
    return { tone: "error", label: "派发未生效", detail: plainReason(watch.disabled) };
  }
  // A real failure comes before a skip line: both can be true at once (a gated
  // round followed by an unreachable server), and the red one is what has to be
  // fixed first. It does not erase the skip reason; the row keeps both.
  if (watch.error) {
    return { tone: "error", label: "派发出错", detail: plainReason(watch.error) };
  }
  if (watch.skipped) {
    return { tone: "skipped", label: "本轮跳过", detail: plainReason(watch.skipped) };
  }
  if (watch.inFlight) return { tone: "ready", label: "正在派发", detail: "已经交出一条，等这个会话结束" };
  // The distinction the panel needs: an empty queue is not the same fact as a
  // round that was held back — the skip line above would still be showing.
  if (watch.idle) return { tone: "ready", label: "派发就绪", detail: "上一轮没有待派条目" };
  return { tone: "ready", label: "派发就绪", detail: "到达派发间隔后会接手待派条目" };
}
