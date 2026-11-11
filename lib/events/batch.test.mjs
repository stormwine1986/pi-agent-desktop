import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { Coalescer } = await jiti.import("./batch.ts");
const { renderInjection, MAX_LISTED_HITS } = await jiti.import("./inject-text.ts");

function rule(overrides = {}) {
  return {
    id: "s1#rule",
    name: "rule",
    server: "entity-base",
    workspace: "ws_a",
    action: "wake",
    filter: { events: [], entityTypes: [], operator: null, linkTypes: [], custom: null },
    match: { eventType: null, aggregateType: null, from: null, to: null, changedFields: null, operator: null },
    coalesceSec: 5,
    maxPerHour: 20,
    recheck: false,
    inject: null,
    ...overrides,
  };
}

function descriptor(overrides = {}) {
  return {
    eventId: `e${Math.random()}`,
    eventType: "entity.transitioned",
    aggregateType: "Widget",
    aggregateId: "ent_1",
    workspaceId: "ws_a",
    operator: "alice",
    revision: 1,
    from: "OPEN",
    to: "DONE",
    changedFields: ["state"],
    timestamp: "2026-11-11T02:00:00.000Z",
    key: null,
    ...overrides,
  };
}

/** A hand-cranked clock so a window can be opened and expired on demand. */
function fakeClock() {
  let now = 1_000;
  const timers = [];
  return {
    deps: {
      now: () => now,
      setTimeout: (handler) => {
        timers.push(handler);
        return timers.length - 1;
      },
      clearTimeout: () => {},
    },
    advance(ms) {
      now += ms;
    },
    fireAll() {
      for (const handler of timers.splice(0)) handler();
    },
  };
}

test("the same aggregate twice in one window is one hit with hitCount 2", () => {
  const clock = fakeClock();
  const flushed = [];
  const coalescer = new Coalescer((batch) => flushed.push(batch), clock.deps);
  coalescer.add("s1", rule(), descriptor({ to: "DONE" }));
  clock.advance(1_000);
  coalescer.add("s1", rule(), descriptor({ from: "DONE", to: "STUCK" }));
  clock.fireAll();

  assert.equal(flushed.length, 1, "one injection for two transitions");
  assert.equal(flushed[0].hits.length, 1);
  assert.equal(flushed[0].hits[0].hitCount, 2);
  assert.equal(flushed[0].count, 2);
  // The newest transition is the one that describes the entity now.
  assert.equal(flushed[0].hits[0].from, "DONE");
  assert.equal(flushed[0].hits[0].to, "STUCK");
});

test("different aggregates in one window become one batch with both entries", () => {
  const clock = fakeClock();
  const flushed = [];
  const coalescer = new Coalescer((batch) => flushed.push(batch), clock.deps);
  coalescer.add("s1", rule(), descriptor({ aggregateId: "ent_1", key: "WIDGET-1" }));
  clock.advance(500);
  coalescer.add("s1", rule(), descriptor({ aggregateId: "ent_2", aggregateType: "Gadget", key: "GADGET-9" }));
  clock.fireAll();

  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].hits.length, 2);
  assert.equal(flushed[0].count, 2);
  assert.deepEqual(flushed[0].hits.map((hit) => hit.aggregateId), ["ent_1", "ent_2"]);
});

test("two rules of one session keep separate windows", () => {
  const clock = fakeClock();
  const flushed = [];
  const coalescer = new Coalescer((batch) => flushed.push(batch), clock.deps);
  coalescer.add("s1", rule({ id: "s1#a" }), descriptor());
  coalescer.add("s1", rule({ id: "s1#b" }), descriptor());
  clock.fireAll();
  assert.equal(flushed.length, 2);
  assert.deepEqual(flushed.map((batch) => batch.subscription.id).sort(), ["s1#a", "s1#b"]);
});

test("the injected text starts with the fixed line and lists the events", () => {
  const clock = fakeClock();
  let batch = null;
  const coalescer = new Coalescer((value) => { batch = value; }, clock.deps);
  coalescer.add("s1", rule(), descriptor({ key: "WIDGET-1" }));
  clock.fireAll();

  const { text, subscriptionId } = renderInjection(batch);
  assert.equal(subscriptionId, "s1#rule");
  const lines = text.split("\n");
  assert.equal(lines[0], "[事件] s1#rule");
  assert.match(text, /1 条变化/);
  assert.match(text, /WIDGET-1/);
  assert.match(text, /OPEN → DONE/);
  assert.match(text, /这不是断言/);
});

test("a long batch lists ten events and counts the rest", () => {
  const clock = fakeClock();
  let batch = null;
  const coalescer = new Coalescer((value) => { batch = value; }, clock.deps);
  for (let index = 0; index < MAX_LISTED_HITS + 3; index += 1) {
    coalescer.add("s1", rule(), descriptor({ aggregateId: `ent_${index}`, key: `WIDGET-${index}` }));
  }
  clock.fireAll();

  const text = renderInjection(batch).text;
  assert.equal(text.split("\n").filter((line) => line.startsWith("- ")).length, MAX_LISTED_HITS);
  assert.match(text, /… 还有 3 条/);
  assert.match(text, /13 条变化/);
});

test("a custom template fills only the whitelisted placeholders", () => {
  const clock = fakeClock();
  let batch = null;
  const coalescer = new Coalescer((value) => { batch = value; }, clock.deps);
  coalescer.add("s1", rule({ inject: "count={{count}} type={{aggregateType}} op={{operator}} hit={{hitCount}}" }), descriptor());
  clock.fireAll();

  const text = renderInjection(batch).text;
  assert.match(text, /count=1 type=Widget op=alice hit=1/);
  assert.ok(!text.includes("{{"), "no placeholder survives rendering");
});
