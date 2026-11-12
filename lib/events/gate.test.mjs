import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  withinWindow,
  quotaExhausted,
  quietRemainingMs,
  loopExhausted,
  evaluateGates,
  recordGateDelivery,
  stormReached,
} = await jiti.import("./gate.ts");

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function hits(...ids) {
  return ids.map((aggregateId) => ({ aggregateId }));
}

test("window pruning keeps only timestamps newer than the window", () => {
  assert.deepEqual(withinWindow([NOW - 120_000, NOW - 30_000, NOW], NOW, 60), [NOW - 30_000, NOW]);
  assert.deepEqual(withinWindow([NOW], NOW, 0), []);
});

test("maxPerHour is a rolling hour, not a calendar hour", () => {
  assert.equal(quotaExhausted([NOW - 3_700_000], NOW, 1), false);
  assert.equal(quotaExhausted([NOW - 59 * MINUTE], NOW, 1), true);
  // One inside the hour is enough, however many older stamps are there.
  assert.equal(quotaExhausted([NOW - 3_700_000, NOW - 59 * MINUTE], NOW, 1), true);
  assert.equal(quotaExhausted([NOW - 59 * MINUTE, NOW - 30 * MINUTE], NOW, 2), true);
});

test("selfQuietSec reports the remaining wait and 0 disables it", () => {
  assert.equal(quietRemainingMs(null, NOW, 15), 0);
  assert.equal(quietRemainingMs(NOW - 16_000, NOW, 15), 0);
  assert.equal(quietRemainingMs(NOW - 5_000, NOW, 15), 10_000);
  assert.equal(quietRemainingMs(NOW - 5_000, NOW, 0), 0);
});

test("the loop fuse counts one aggregate inside its window", () => {
  const history = { a1: [NOW - 10_000, NOW - 2_000], a2: [NOW - 200_000] };
  assert.equal(loopExhausted(hits("a1"), history, NOW, 300, 3).blocked, null);
  assert.deepEqual(loopExhausted(hits("a1"), history, NOW, 300, 2), { blocked: "a1", count: 2 });
  // The old stamp is outside the window, so it does not count.
  assert.equal(loopExhausted(hits("a2"), history, NOW, 300, 3).blocked, null);
  assert.equal(loopExhausted(hits("a3"), history, NOW, 300, 1).blocked, null);
});

test("gates run in order: quiet period, then quota, then loop", () => {
  const base = {
    now: NOW,
    selfQuietSec: 15,
    lastDeliveredAt: NOW - 1_000,
    delivered: [NOW - 2_000, NOW - 3_000],
    maxPerHour: 2,
    loopWindowSec: 300,
    loopMaxHits: 3,
    aggregateDeliveries: { a1: [NOW - 1_000, NOW - 2_000, NOW - 3_000] },
    hits: hits("a1"),
  };
  // Quiet period first: it is the cheapest and the most local gate.
  assert.equal(evaluateGates(base).skip, "self");

  const noQuiet = { ...base, selfQuietSec: 0 };
  assert.equal(evaluateGates(noQuiet).skip, "limited");

  const underQuota = { ...noQuiet, maxPerHour: 10 };
  const verdict = evaluateGates(underQuota);
  assert.equal(verdict.skip, "loop");
  assert.match(verdict.detail, /a1/);

  const clear = { ...underQuota, aggregateDeliveries: {} };
  assert.deepEqual(evaluateGates(clear), { skip: null, detail: "" });
});

test("one coalesced batch charges the quota once, not once per event", () => {
  // The batch already merged `a1` twice; recording it must add one stamp.
  const once = recordGateDelivery([], {}, hits("a1", "a1"), NOW);
  assert.deepEqual(once.delivered, [NOW]);
  const twice = recordGateDelivery(once.delivered, once.aggregateDeliveries, hits("a1"), NOW + 1);
  assert.equal(twice.delivered.length, 2);
  assert.equal(twice.aggregateDeliveries.a1.length, 2);
});

test("the storm fuse trips at the threshold and names the count", () => {
  const deliveries = Array.from({ length: 6 }, (_, index) => NOW - index * 60_000);
  assert.deepEqual(stormReached(deliveries, NOW, 600, 6), { tripped: true, count: 6 });
  assert.deepEqual(stormReached(deliveries, NOW, 600, 7), { tripped: false, count: 6 });
  // Outside the window the fuse forgets: it is not a lifetime counter.
  assert.equal(stormReached(deliveries.map((time) => time - 3_600_000), NOW, 600, 6).tripped, false);
});
