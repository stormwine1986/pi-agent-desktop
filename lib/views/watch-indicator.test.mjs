import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { watchIndicator, plainReason } = await jiti.import("./watch-indicator.ts");

/**
 * SSR-000089 AC-11: the four states of a view have to be distinguishable from
 * what `/api/views` answers with, and none of them may fall back to "silent".
 *
 * The four inputs below are the whole public surface of the panel's indicator:
 * `null` (not watched), a skip line, a disabled reason, and a clean watch.
 */

test("a view without dispatch has no indicator at all — not a grey dot", () => {
  assert.equal(watchIndicator(null), null);
  assert.equal(watchIndicator(undefined), null);
});

test("watched, enabled, nothing handed out: ready — and it reads differently from not watched", () => {
  const ready = watchIndicator({ disabled: null, inFlight: false, skipped: null });
  assert.equal(ready.tone, "ready");
  assert.equal(ready.label, "派发就绪");
  assert.notEqual(watchIndicator(null), ready);
});

test("a running session is still ready, but says what is happening", () => {
  const busy = watchIndicator({ disabled: null, inFlight: true, skipped: null });
  assert.equal(busy.tone, "ready");
  assert.equal(busy.label, "正在派发");
});

test("a gated round keeps its reason verbatim", () => {
  const gated = watchIndicator({ disabled: null, inFlight: false, skipped: "有 1 条待人工" });
  assert.equal(gated.tone, "skipped");
  assert.equal(gated.label, "本轮跳过");
  assert.equal(gated.detail, "有 1 条待人工");
});

test("a broken or paused view is an error state, and outranks a stale skip line", () => {
  const error = watchIndicator({ disabled: "配置里关闭了派发", inFlight: false, skipped: "项目有运行中会话" });
  assert.equal(error.tone, "error");
  assert.equal(error.label, "派发未生效");
  assert.equal(error.detail, "配置里关闭了派发");
});

test("error reasons name what is missing instead of a configuration field", () => {
  assert.equal(plainReason("watch.project 不是目录：../nowhere"), "执行项目的目录不存在：../nowhere");
  assert.equal(plainReason("watch.prompt 不存在：.pi/prompts/x.md"), "任务说明文件不存在：.pi/prompts/x.md");
  assert.equal(plainReason("watch.intervalSec 非法"), "派发设置 非法");
  assert.equal(plainReason('watch.claim.manual 不能等于 from（DEFINED）'), "待人工状态 不能等于 from（DEFINED）");
});

test("no state leaks a configuration key into the tooltip", () => {
  const states = [
    { disabled: null, inFlight: false, skipped: null },
    { disabled: null, inFlight: true, skipped: null },
    { disabled: null, inFlight: false, skipped: "项目有运行中会话" },
    { disabled: "watch.project 不是目录：x", inFlight: false, skipped: null },
    { disabled: "watch.claim.from 不是状态", inFlight: false, skipped: null },
  ];
  for (const state of states) {
    const indicator = watchIndicator(state);
    const text = `${indicator.label} ${indicator.detail}`;
    assert.doesNotMatch(text, /watch|claim|intervalSec|timeoutMin/i, `jargon in "${text}"`);
  }
});
