import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { applySubscriptionPatch, saveSubscriptionPatch, draftSubscription, readPanelPatch, findRuleBlock } = await jiti.import("./edit.ts");

/** A file with comments, two rules and an unrelated session: the edit must leave all of it alone. */
const FILE = `version: 1
# 这个文件是项目的意图，注释要活下来
sessions:
  - sessionId: "01a1c87d-test"
    title: "编排"            # 只影响显示
    stormWindowSec: 600
    subscriptions:
      - name: "有进展就叫我"
        server: entity-base
        workspace: ws_entity_base
        action: wake            # wake | notify
        filter:
          events: [entity.transitioned]
        match:
          to: [DONE, STUCK]
          # 只要真正需要我决策的状态
        coalesceSec: 5
        inject: |
          {{count}} 条变化
      - name: "另一条规则"
        server: entity-base
        workspace: ws_entity_base
        action: notify

  - sessionId: "01a1c87d-other"
    subscriptions:
      - name: "有进展就叫我"
        server: other-base
        workspace: ws_other
        action: wake
`;

function withProject(body, run) {
  const dir = mkdtempSync(join(tmpdir(), "events-edit-"));
  try {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "events.yaml"), body, "utf8");
    return run(dir, join(dir, ".pi", "events.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TARGET = { sessionId: "01a1c87d-test", name: "有进展就叫我" };

test("the rule block is found by session and name, not by position", () => {
  const block = findRuleBlock(FILE, TARGET);
  assert.ok(block);
  assert.match(block.lines[0], /- name: "有进展就叫我"/);
  // The other rule under the same session is not part of the block.
  assert.ok(!block.lines.some((line) => line.includes("另一条规则")));
});

test("rewriting action and coalesceSec keeps every comment and the other rules", () => {
  const result = applySubscriptionPatch(FILE, TARGET, { action: "notify", coalesceSec: 9 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changed.sort(), ["action", "coalesceSec"]);
  assert.match(result.text, /action: notify            # wake \| notify/, "the trailing comment survives");
  assert.match(result.text, /coalesceSec: 9$/m);
  // Everything outside the two keys is byte-identical, comments included.
  assert.match(result.text, /# 这个文件是项目的意图，注释要活下来/);
  assert.match(result.text, /title: "编排"            # 只影响显示/);
  assert.match(result.text, /# 只要真正需要我决策的状态/);
  assert.match(result.text, /- name: "另一条规则"[\s\S]*action: notify\n/, "the second rule is untouched");
  assert.match(result.text, /sessionId: "01a1c87d-other"/);
});

test("a match block is replaced in place, its comments stay where they belong", () => {
  const result = applySubscriptionPatch(FILE, TARGET, { match: { to: ["DONE"], from: ["OPEN"] } });
  assert.equal(result.ok, true);
  assert.match(result.text, /        match:\n          to: \[DONE\]\n          from: \[OPEN\]\n/);
  // The comment that sat inside the old block is gone with the block it described...
  assert.doesNotMatch(result.text, /# 只要真正需要我决策的状态/);
  // ...but the next key still follows the new block.
  assert.match(result.text, /from: \[OPEN\]\n        coalesceSec: 5/);
});

test("an absent key is inserted at the rule's own indentation", () => {
  const withoutAction = FILE.replace("        action: wake            # wake | notify\n", "");
  const result = applySubscriptionPatch(withoutAction, TARGET, { action: "notify" });
  assert.equal(result.ok, true);
  assert.match(result.text, /        action: notify\n/);
  // Still one rule per block: the inserted line is not attributed to the next item.
  assert.match(result.text, /coalesceSec: 5\n        inject: \|/);
});

test("a bad value is refused with the loader's own sentence and a line", () => {
  withProject(FILE, (dir, path) => {
    const before = readFileSync(path, "utf8");
    const outcome = saveSubscriptionPatch(dir, TARGET, { action: "wakeup" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, 'action 只能是 wake 或 notify（写的是 "wakeup"）');
    assert.equal(outcome.line, 11, "the action line of that rule");
    assert.equal(readFileSync(path, "utf8"), before, "a refused edit writes nothing");

    const bad = saveSubscriptionPatch(dir, TARGET, { coalesceSec: 0 });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /^coalesceSec 必须是正整数（写的是 0）$/);
    assert.equal(readFileSync(path, "utf8"), before);

    const unknownMatch = saveSubscriptionPatch(dir, TARGET, { match: { key: ["TASK-1"] } });
    assert.equal(unknownMatch.ok, false);
    assert.match(unknownMatch.error, /^match\.key：事件信封里只有 aggregateId，没有 key/);
  });
});

test("a good edit is written, and the rule it leaves behind parses", () => {
  withProject(FILE, (dir, path) => {
    const outcome = saveSubscriptionPatch(dir, TARGET, {
      action: "notify",
      coalesceSec: 12,
      match: { to: ["DONE"] },
    });
    assert.equal(outcome.ok, true, outcome.error ?? "");
    assert.deepEqual(outcome.changed.sort(), ["action", "coalesceSec", "match"]);
    assert.equal(outcome.subscription.action, "notify");
    assert.equal(outcome.subscription.coalesceSec, 12);
    assert.deepEqual(outcome.subscription.match.to, ["DONE"]);
    assert.equal(outcome.subscription.match.from, null);
    const written = readFileSync(path, "utf8");
    assert.match(written, /# 这个文件是项目的意图/);
    assert.equal(outcome.lines.action, 11);
  });
});

test("a draft validates the patch without writing anything", () => {
  withProject(FILE, (dir, path) => {
    const before = readFileSync(path, "utf8");
    const draft = draftSubscription(dir, TARGET, { action: "notify" });
    assert.equal(draft.ok, true);
    assert.equal(draft.subscription.action, "notify");
    assert.equal(readFileSync(path, "utf8"), before);

    const refused = draftSubscription(dir, TARGET, { coalesceSec: "abc" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, 'coalesceSec 必须是正整数（写的是 "abc"）');
    assert.equal(readFileSync(path, "utf8"), before);
  });
});

test("the panel patch is a closed set, and match values become string lists", () => {
  assert.deepEqual(readPanelPatch(undefined), { patch: {} });
  const bad = readPanelPatch({ loopMaxHits: 2 });
  assert.match(bad.error, /patch 只接受 action \/ coalesceSec \/ match/);
  assert.match(readPanelPatch({ action: 5 }).error, /action 必须是字符串/);
  const ok = readPanelPatch({ match: { to: "DONE", from: ["OPEN", " "], changedFields: [] } });
  assert.deepEqual(ok.patch.match, { to: ["DONE"], from: ["OPEN"], changedFields: [] });
});

test("a CRLF file is edited in place, and its line endings are not converted", () => {
  // A Windows editor writes this file with CRLF; the scanner used to fail on it
  // (the whole rule was "not found"), which is a silent edit failure.
  const crlf = FILE.replace(/\n/g, "\r\n");
  const result = applySubscriptionPatch(crlf, TARGET, { action: "notify", match: { to: ["DONE"] } });
  assert.equal(result.ok, true);
  assert.match(result.text, /action: notify/);
  assert.match(result.text, /\r\n/);
  assert.ok(result.text.split("\r\n").every((line) => !line.includes("\n")), "no mixed endings");
  // The reported lines are counted on the normalised text, i.e. still correct.
  assert.equal(result.lines.match, 14);
});
