import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readSessionFile, invalidateSessionReadCache, SESSION_READ_CACHE_LIMITS } = await jiti.import("./session-read.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

// TASK-000113: `GET /api/sessions/[id]` no longer opens a SessionManager — it
// derives everything from the JSONL entries (see lib/session-read.ts). The
// client renders that derivation, so it has to agree with the SDK one for one.
// Every case below writes a real session file, reads it both ways, and compares
// what the routes actually use: the entries, the leaf, the tree (with labels),
// the session name and the header.

const HEADER = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" };

function user(id, parentId, text, timestamp = "2026-01-01T00:00:00.000Z") {
  return { type: "message", id, parentId, timestamp, message: { role: "user", content: text } };
}
function assistant(id, parentId, text, timestamp = "2026-01-01T00:00:01.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text }] },
  };
}
function toolResult(id, parentId, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:02.000Z",
    message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text }] },
  };
}

function writeSession(t, entries, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-session-read-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (options.trailingNewline === false ? "" : "\n"));
  invalidateSessionReadCache();
  t.after(() => {
    invalidateSessionReadCache();
    rmSync(dir, { recursive: true, force: true });
  });
  return filePath;
}

function treeShape(nodes) {
  return nodes.map((node) => ({
    id: node.entry.id,
    parentId: node.entry.parentId,
    type: node.entry.type,
    label: node.label ?? null,
    labelTimestamp: node.labelTimestamp ?? null,
    children: treeShape(node.children),
  }));
}

function compareWithSdk(filePath) {
  const view = readSessionFile(filePath);
  const sm = SessionManager.open(filePath);
  assert.deepEqual(view.entries, sm.getEntries(), "entries");
  assert.equal(view.leafId, sm.getLeafId(), "leafId");
  assert.deepEqual(view.header, sm.getHeader(), "header");
  assert.equal(view.sessionName, sm.getSessionName(), "sessionName");
  assert.deepEqual(treeShape(view.tree), treeShape(sm.getTree()), "tree");
  assert.equal(view.needsSessionManager, false);
  return { view, sm };
}

test("a linear session reads like the SDK's manager", (t) => {
  const filePath = writeSession(t, [HEADER, user("u1", null, "hi"), toolResult("t1", "u1", "out"), assistant("a1", "t1", "there")]);
  const { view, sm } = compareWithSdk(filePath);
  assert.equal(view.leafId, "a1");
  assert.equal(view.entries.length, 3);
  assert.equal(sm.getSessionFile(), view.filePath.replace(/\//g, process.platform === "win32" ? "\\" : "/"));
});

test("a branch reads like the SDK's manager, leaf included", (t) => {
  const filePath = writeSession(t, [
    HEADER,
    user("u1", null, "start"),
    assistant("a1", "u1", "first answer", "2026-01-01T00:00:01.000Z"),
    assistant("a2", "u1", "second answer", "2026-01-01T00:00:02.000Z"),
  ]);
  const { view } = compareWithSdk(filePath);
  assert.equal(view.leafId, "a2", "the last entry on disk is where an append goes");
  assert.equal(view.tree.length, 1);
  assert.equal(view.tree[0].children.length, 2);
});

test("children sort oldest first, as the SDK sorts them", (t) => {
  // Written newest first: the SDK sorts by timestamp, not by file order.
  const filePath = writeSession(t, [
    HEADER,
    user("u1", null, "start"),
    assistant("a2", "u1", "later", "2026-01-01T00:00:09.000Z"),
    assistant("a1", "u1", "earlier", "2026-01-01T00:00:03.000Z"),
  ]);
  const { view } = compareWithSdk(filePath);
  assert.deepEqual(view.tree[0].children.map((child) => child.entry.id), ["a1", "a2"]);
});

test("labels, a cleared label and a renamed session read like the SDK's manager", (t) => {
  const filePath = writeSession(t, [
    HEADER,
    user("u1", null, "start"),
    { type: "label", id: "l1", parentId: "u1", timestamp: "2026-01-01T00:00:03.000Z", targetId: "u1", label: "checkpoint" },
    assistant("a1", "l1", "reply"),
    { type: "session_info", id: "i1", parentId: "a1", timestamp: "2026-01-01T00:00:04.000Z", name: "  my chat  " },
    { type: "label", id: "l2", parentId: "i1", timestamp: "2026-01-01T00:00:05.000Z", targetId: "u1", label: "" },
    { type: "session_info", id: "i2", parentId: "l2", timestamp: "2026-01-01T00:00:06.000Z", name: "" },
  ]);
  const { view } = compareWithSdk(filePath);
  assert.equal(view.sessionName, undefined, "the newest session_info clears the title");
  assert.equal(view.leafId, "i2", "the leaf includes meta entries, as the SDK's index does");
});

test("compaction, custom messages and model changes read like the SDK's manager", (t) => {
  const filePath = writeSession(t, [
    HEADER,
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "p", modelId: "m" },
    user("u1", "m1", "long conversation"),
    assistant("a1", "u1", "answer"),
    { type: "compaction", id: "c1", parentId: "a1", timestamp: "2026-01-01T00:00:05.000Z", summary: "sum", firstKeptEntryId: "u1", tokensBefore: 10 },
    { type: "custom_message", id: "x1", parentId: "c1", timestamp: "2026-01-01T00:00:06.000Z", customType: "pi-web:note", content: "note", display: true },
    { type: "thinking_level_change", id: "th1", parentId: "x1", timestamp: "2026-01-01T00:00:07.000Z", thinkingLevel: "high" },
  ]);
  compareWithSdk(filePath);
});

test("an interrupted line at the end of the file is skipped, not fatal", (t) => {
  const filePath = writeSession(t, [HEADER, user("u1", null, "start"), assistant("a1", "u1", "answer")]);
  appendFileSync(filePath, '{"type":"message","id":"torn"');
  const { view } = compareWithSdk(filePath);
  assert.equal(view.entries.length, 2);
});

test("a malformed line in the middle is skipped, as the SDK's loader skips it", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-session-read-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(
    filePath,
    [JSON.stringify(HEADER), JSON.stringify(user("u1", null, "start")), "{not json", JSON.stringify(assistant("a1", "u1", "answer"))].join("\n") + "\n",
  );
  invalidateSessionReadCache();
  t.after(() => {
    invalidateSessionReadCache();
    rmSync(dir, { recursive: true, force: true });
  });
  compareWithSdk(filePath);
});

test("the view is cached by fingerprint and invalidated by an append", (t) => {
  const filePath = writeSession(t, [HEADER, user("u1", null, "start")]);
  const first = readSessionFile(filePath);
  assert.strictEqual(readSessionFile(filePath), first, "unchanged file reuses the parsed view");
  appendFileSync(filePath, `${JSON.stringify(assistant("a1", "u1", "answer"))}\n`);
  const second = readSessionFile(filePath);
  assert.notStrictEqual(second, first);
  assert.equal(second.entries.length, 2);
});

test("a session older than the current format is handed to the SDK instead of being read here", (t) => {
  const filePath = writeSession(t, [{ ...HEADER, version: 1 }, user("u1", null, "start")]);
  const view = readSessionFile(filePath);
  assert.equal(view.needsSessionManager, true);
});

test("a file that is not a session hands the request to the SDK, which refuses it", (t) => {
  const filePath = writeSession(t, [user("u1", null, "start")]);
  assert.equal(readSessionFile(filePath).needsSessionManager, true);
});

test("the cache budget bounds what a read holds", (t) => {
  const limits = { ...SESSION_READ_CACHE_LIMITS };
  t.after(() => Object.assign(SESSION_READ_CACHE_LIMITS, limits));
  SESSION_READ_CACHE_LIMITS.maxEntries = 2;
  const files = [1, 2, 3].map((index) => writeSession(t, [HEADER, user(`u${index}`, null, "start")]));
  const first = readSessionFile(files[0]);
  readSessionFile(files[1]);
  readSessionFile(files[2]);
  assert.notStrictEqual(readSessionFile(files[0]), first, "the oldest view was evicted");
});
