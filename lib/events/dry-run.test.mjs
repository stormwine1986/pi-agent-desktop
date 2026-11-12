import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { dryRunSubscription, selfExcitationWarning, describeDryRun } = await jiti.import("./dry-run.ts");

/** One rule as `readEventsConfig()` would hand it over. */
function rule(overrides = {}) {
  return {
    id: "01a1-test#r",
    name: "r",
    server: "entity-base",
    workspace: "ws_a",
    action: "wake",
    filter: { events: ["entity.transitioned"], entityTypes: [], operator: null, linkTypes: [], custom: null },
    match: { eventType: null, aggregateType: null, from: null, to: null, changedFields: null, operator: null },
    coalesceSec: 5,
    maxPerHour: 20,
    recheck: false,
    selfQuietSec: 15,
    loopWindowSec: 300,
    loopMaxHits: 3,
    stormWindowSec: 600,
    stormMaxDeliveries: 6,
    inject: null,
    ...overrides,
  };
}

function descriptor(overrides = {}) {
  return {
    eventId: "evt_1",
    eventType: "entity.transitioned",
    aggregateType: "Widget",
    aggregateId: "ent_1",
    workspaceId: "ws_a",
    operator: "alice",
    revision: 2,
    from: "OPEN",
    to: "DONE",
    changedFields: ["state"],
    timestamp: "2026-11-11T02:00:00.000Z",
    key: "W-1",
    ...overrides,
  };
}

const COARSE = { events: ["entity.transitioned"], entityTypes: [] };
const GATE = { pausedReason: null, lastWakeAt: null, hourlyCount: 0, maxPerHour: 20, selfQuietSec: 15, running: false };

test("a state the rule asks for is a hit, and the reason quotes both sides", () => {
  const result = dryRunSubscription(
    rule({ match: { ...rule().match, to: ["DONE"] } }),
    [{ descriptor: descriptor(), receivedAt: 1, catchUp: false }],
    COARSE,
    GATE,
  );
  assert.equal(result.hits.length, 1);
  assert.equal(result.misses.length, 0);
  assert.match(result.hits[0].reasons.join("\n"), /命中 match\.to：事件的 to = DONE 在 \[DONE\] 里/);
});

test("a miss names the field, the predicate and the value — never just 'no match'", () => {
  const result = dryRunSubscription(
    rule({ match: { ...rule().match, to: ["STUCK"] } }),
    [{ descriptor: descriptor(), receivedAt: 1, catchUp: false }],
    COARSE,
    GATE,
  );
  assert.equal(result.hits.length, 0);
  assert.equal(result.misses[0].stage, "match");
  assert.match(result.misses[0].reasons.join("\n"), /match\.to = \[STUCK\]，事件的 to 是 DONE/);
});

test("creation has no previous state, and the reason says so", () => {
  const created = descriptor({ eventId: "evt_2", eventType: "entity.created", from: null, to: "DRAFT", changedFields: ["name"] });
  const result = dryRunSubscription(
    rule({
      filter: { ...rule().filter, events: ["entity.created", "entity.transitioned"] },
      match: { ...rule().match, from: ["OPEN"] },
    }),
    [{ descriptor: created, receivedAt: 1, catchUp: false }],
    { events: ["entity.created", "entity.transitioned"], entityTypes: [] },
    GATE,
  );
  assert.equal(result.misses[0].stage, "match");
  assert.match(result.misses[0].reasons.join("\n"), /match\.from = \[OPEN\]，事件的 from 是 null/);
});

test("the server-side stage is judged on the channel union, and says the rule's own filter is not re-applied", () => {
  const result = dryRunSubscription(
    rule(),
    [{ descriptor: descriptor({ eventType: "entity.updated" }), receivedAt: 1, catchUp: false }],
    COARSE,
    GATE,
  );
  assert.equal(result.misses[0].stage, "filter");
  assert.match(result.misses[0].reasons[0], /entity\.updated 不在服务端粗筛（本 channel 的 filter\.events 并集 \[entity\.transitioned\]）/);
  assert.match(result.misses[0].reasons[1], /运行时不按本规则的 filter 再筛一次/);
});

test("changedFields is list against list", () => {
  const result = dryRunSubscription(
    rule({ match: { ...rule().match, changedFields: ["assignee"] } }),
    [{ descriptor: descriptor(), receivedAt: 1, catchUp: false }],
    COARSE,
    GATE,
  );
  assert.equal(result.misses[0].stage, "match");
  assert.match(result.misses[0].reasons.join("\n"), /match\.changedFields = \[assignee\]，事件变动的字段是 \[state\]（没有交集）/);
});

test("the gate preview says why a hit would still not arrive right now", () => {
  const events = [{ descriptor: descriptor(), receivedAt: 1, catchUp: false }];
  const quota = dryRunSubscription(rule({ match: { ...rule().match, to: ["DONE"] } }), events, COARSE, {
    ...GATE,
    hourlyCount: 20,
  });
  assert.match(quota.blockedBy, /maxPerHour: 20/);
  const quiet = dryRunSubscription(rule({ match: { ...rule().match, to: ["DONE"] } }), events, COARSE, {
    ...GATE,
    lastWakeAt: 90_000,
  }, 100_000);
  assert.match(quiet.blockedBy, /不足 selfQuietSec: 15/);
  const busy = dryRunSubscription(rule({ match: { ...rule().match, to: ["DONE"] } }), events, COARSE, { ...GATE, running: true });
  assert.match(busy.delayedBy, /pendingBatch/);
});

test("a dry run neither delivers nor counts: the same inputs give the same answer", () => {
  const events = [{ descriptor: descriptor(), receivedAt: 1, catchUp: false }];
  const first = dryRunSubscription(rule(), events, COARSE, GATE);
  const second = dryRunSubscription(rule(), events, COARSE, GATE);
  assert.deepEqual(first, second);
});

test("an empty buffer says so instead of pretending nothing matches", () => {
  const result = dryRunSubscription(rule(), [], COARSE, GATE);
  assert.equal(result.evaluated, 0);
  assert.match(describeDryRun(result), /还没有事件/);
});

test("self-excitation warns on created + wake, and a narrowed state predicate silences it", () => {
  const wide = rule({
    filter: { ...rule().filter, events: ["entity.created"] },
  });
  const warning = selfExcitationWarning(wide);
  assert.equal(warning.code, "self-excitation");
  assert.match(warning.message, /entity\.created/);
  assert.match(warning.message, /action: wake/);

  // AC-5: adding `to: [FINISHED]` narrows it away.
  assert.equal(selfExcitationWarning({ ...wide, match: { ...wide.match, to: ["FINISHED"] } }), null);
  // The same narrowing on `from` counts too.
  assert.equal(selfExcitationWarning({ ...wide, match: { ...wide.match, from: ["OPEN"] } }), null);
  // `["*"]` is "any", i.e. not a narrowing.
  assert.ok(selfExcitationWarning({ ...wide, match: { ...wide.match, to: ["*"] } }));

  // The other two ways out.
  assert.equal(selfExcitationWarning({ ...wide, action: "notify" }), null);
  assert.equal(
    selfExcitationWarning({ ...wide, match: { ...wide.match, eventType: ["entity.transitioned"] } }),
    null,
  );
  // Wildcards include creation.
  assert.ok(selfExcitationWarning(rule({ filter: { ...rule().filter, events: ["entity.*"] } })));
  assert.ok(selfExcitationWarning(rule({ filter: { ...rule().filter, events: [] }, match: { ...rule().match, eventType: ["entity.updated"] } })));
  // A rule that never mentions creation says nothing.
  assert.equal(selfExcitationWarning(rule()), null);
});
