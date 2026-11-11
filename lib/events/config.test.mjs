import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { readEventsConfig, usableSubscriptions, findUnknownPlaceholders } = await jiti.import("./config.ts");

function withEvents(body, run) {
  const dir = mkdtempSync(join(tmpdir(), "events-config-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "events.yaml"), body, "utf8");
    return run(readEventsConfig(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID = [
  "version: 1",
  "sessions:",
  '  - sessionId: "01a1c87d-test"',
  '    title: "编排"',
  "    subscriptions:",
  '      - name: "有进展就叫我"',
  "        server: entity-base",
  "        workspace: ws_entity_base",
  "        action: wake",
  "        filter:",
  "          events: [entity.transitioned]",
  "          entityTypes: [Widget, Gadget]",
  "        match:",
  "          to: [DONE, STUCK]",
  "        coalesceSec: 5",
  "        maxPerHour: 9",
  "        inject: |",
  "          [事件] {{count}} 条（{{window}}s）",
  "          {{events}}",
  "",
].join("\n");

test("a well-formed file loads every rule with its id", () => {
  withEvents(VALID, (config) => {
    assert.equal(config.error, null);
    assert.equal(config.sessions.length, 1);
    assert.equal(config.sessions[0].error, null);
    const [loaded] = usableSubscriptions(config);
    assert.equal(loaded.sessionId, "01a1c87d-test");
    assert.equal(loaded.subscription.id, "01a1c87d-test#有进展就叫我");
    assert.deepEqual(loaded.subscription.filter.events, ["entity.transitioned"]);
    assert.deepEqual(loaded.subscription.match.to, ["DONE", "STUCK"]);
    assert.equal(loaded.subscription.coalesceSec, 5);
    assert.equal(loaded.subscription.maxPerHour, 9);
    assert.equal(loaded.subscription.action, "wake");
  });
});

test("a missing file is not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "events-config-"));
  try {
    const config = readEventsConfig(dir);
    assert.equal(config.exists, false);
    assert.equal(config.error, null);
    assert.deepEqual(config.sessions, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("filter.state is refused, and the message names the rule and the field", () => {
  const body = VALID.replace("          entityTypes: [Widget, Gadget]", "          state: [DONE]");
  withEvents(body, (config) => {
    const [loaded] = usableSubscriptions(config);
    assert.equal(loaded, undefined);
    const entry = config.sessions[0].subscriptions[0];
    assert.equal(entry.subscription, null);
    assert.match(entry.error, /filter\.state/);
    assert.match(config.sessions[0].error, /#1 "有进展就叫我"/);
    // A refused rule is still listed, so the panel can point at it.
    assert.equal(config.sessions[0].subscriptions.length, 1);
  });
});

test("an unknown filter key is refused by name", () => {
  const body = VALID.replace("          entityTypes: [Widget, Gadget]", "          states: [DONE]");
  withEvents(body, (config) => {
    assert.match(config.sessions[0].subscriptions[0].error, /filter\.states/);
  });
});

test("match.key is refused: the envelope has no key", () => {
  const body = VALID.replace("          to: [DONE, STUCK]", '          key: ["WIDGET-1"]');
  withEvents(body, (config) => {
    assert.match(config.sessions[0].subscriptions[0].error, /match\.key/);
  });
});

test("an undeclared inject placeholder makes the rule illegal", () => {
  const body = VALID.replace("{{events}}", "{{keys}}");
  withEvents(body, (config) => {
    assert.match(config.sessions[0].subscriptions[0].error, /\{\{keys\}\}/);
    assert.match(config.sessions[0].subscriptions[0].error, /未声明/);
  });
});

test("every whitelisted placeholder is accepted", () => {
  const all = [
    "{{count}}", "{{window}}", "{{events}}", "{{aggregateType}}", "{{aggregateId}}",
    "{{workspaceId}}", "{{timestamp}}", "{{operator}}", "{{from}}", "{{to}}", "{{hitCount}}",
  ].join(" ");
  const body = VALID.replace("[事件] {{count}} 条（{{window}}s）", all);
  withEvents(body, (config) => {
    assert.equal(config.sessions[0].subscriptions[0].error, null);
  });
  assert.deepEqual(findUnknownPlaceholders("{{count}} {{nope}}"), ["nope"]);
});

test("duplicate rule names inside one session are refused", () => {
  const body = VALID + VALID.split("    subscriptions:\n")[1].replace('name: "有进展就叫我"', 'name: "有进展就叫我"');
  withEvents(body, (config) => {
    const entries = config.sessions[0].subscriptions;
    assert.equal(entries.length, 2);
    assert.equal(entries[0].error, null);
    assert.match(entries[1].error, /name 重复/);
  });
});

test("duplicate session ids are refused as a whole entry", () => {
  const body = `${VALID}  - sessionId: "01a1c87d-test"\n    subscriptions:\n      - name: "x"\n        server: entity-base\n        workspace: ws\n`;
  withEvents(body, (config) => {
    assert.equal(config.sessions.length, 2);
    assert.match(config.sessions[1].error, /sessionId 重复/);
    assert.equal(config.sessions[1].subscriptions.length, 0);
    // The first entry still works: one bad entry never disables another.
    assert.equal(usableSubscriptions(config).length, 1);
  });
});

test("defaults: coalesceSec 30, maxPerHour 20, action wake", () => {
  const body = VALID
    .replace("        action: wake\n", "")
    .replace("        coalesceSec: 5\n", "")
    .replace("        maxPerHour: 9\n", "");
  withEvents(body, (config) => {
    const [loaded] = usableSubscriptions(config);
    assert.equal(loaded.subscription.coalesceSec, 30);
    assert.equal(loaded.subscription.maxPerHour, 20);
    assert.equal(loaded.subscription.action, "wake");
  });
});

test("notify is a valid action (M1 reports it as paused rather than refusing the file)", () => {
  const body = VALID.replace("        action: wake", "        action: notify");
  withEvents(body, (config) => {
    const [loaded] = usableSubscriptions(config);
    assert.equal(loaded.subscription.action, "notify");
  });
});

test("a rule without server/workspace is refused, not defaulted", () => {
  const body = VALID.replace("        server: entity-base\n", "");
  withEvents(body, (config) => {
    assert.match(config.sessions[0].subscriptions[0].error, /server/);
  });
});

test("bad YAML is a file-level error, with no sessions", () => {
  withEvents("sessions: [\n", (config) => {
    assert.match(config.error, /YAML/);
    assert.deepEqual(config.sessions, []);
  });
});
