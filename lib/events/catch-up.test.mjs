import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { streamIdMs, compareStreamIds, isBackfill, isRecoverableGap, gapNoticeFrom, describeGap, readGapNotice } =
  await jiti.import("./catch-up.ts");

test("a stream id carries the publish time of the event", () => {
  assert.equal(streamIdMs("1794445018256-0"), 1794445018256);
  assert.equal(streamIdMs("42-7"), 42);
  assert.equal(streamIdMs("not-an-id"), null);
  assert.equal(streamIdMs(null), null);
});

test("ids compare by time, then by sequence", () => {
  assert.ok(compareStreamIds("10-0", "9-99") > 0);
  assert.ok(compareStreamIds("10-1", "10-0") > 0);
  assert.equal(compareStreamIds("10-0", "10-0"), 0);
  assert.equal(compareStreamIds(null, "10-0"), 0, "a missing id is never 'older'");
});

test("an event at or below the ready cursor is backfill, above it is live", () => {
  assert.equal(isBackfill("40-0", "50-0"), true);
  assert.equal(isBackfill("50-0", "50-0"), true, "the replay is inclusive");
  assert.equal(isBackfill("51-0", "50-0"), false);
  assert.equal(isBackfill(null, "50-0"), false);
  assert.equal(isBackfill("40-0", null), false, "no cursor: cannot claim it is a replay");
});

test("only busy / unavailable gaps are worth replaying again", () => {
  assert.equal(isRecoverableGap("busy"), true);
  assert.equal(isRecoverableGap("unavailable"), true);
  assert.equal(isRecoverableGap("truncated"), false);
  assert.equal(isRecoverableGap("overflow"), false);
  assert.equal(isRecoverableGap("unknown"), false);
});

test("the gap frame becomes the window, not just a timestamp", () => {
  const notice = gapNoticeFrom({
    at: 1794445100000,
    reason: "truncated",
    dropped: 4,
    lastEventId: "1794445000000-0",
    cursor: "1794445099000-0",
  });
  assert.equal(notice.from, 1794445000000, "left edge = the last event we did see");
  assert.equal(notice.to, 1794445099000, "right edge = the feed head at the gap");
  assert.equal(notice.dropped, 4);
  assert.equal(notice.recoveredAt, null);
  const copy = describeGap(notice);
  assert.match(copy, /确实没有叫醒你/);
  assert.ok(copy.includes(clock(1794445000000)) && copy.includes(clock(1794445099000)), copy);
  assert.match(copy, /至少 4 条/);
});

function clock(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

test("an unrecoverable gap says the count is unknown rather than a tidy zero", () => {
  const notice = gapNoticeFrom({ at: 5, reason: "overflow", dropped: null, lastEventId: "1000-0", cursor: null });
  const copy = describeGap(notice);
  assert.match(copy, /条数无法统计/);
  assert.match(copy, /overflow/);
  assert.doesNotMatch(copy, /已补投/);
});

test("a recovered gap says it was recovered", () => {
  const notice = { ...gapNoticeFrom({ at: 5, reason: "busy", dropped: null, lastEventId: "1000-0", cursor: "2000-0" }), recoveredAt: 3000 };
  assert.match(describeGap(notice), /重连后已补投/);
});

test("a persisted gap is read back only when it has a timestamp", () => {
  assert.equal(readGapNotice({ reason: "busy" }), null);
  assert.equal(readGapNotice("nope"), null);
  const back = readGapNotice({ at: 1, reason: "busy", dropped: 2, from: 3, to: 4, recoveredAt: 5 });
  assert.deepEqual(back, { at: 1, reason: "busy", dropped: 2, from: 3, to: 4, recoveredAt: 5 });
});
