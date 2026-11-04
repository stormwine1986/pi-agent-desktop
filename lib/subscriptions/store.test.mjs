import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  appendEventRecords,
  eventLogPath,
  markWorkspaceSeen,
  readCursor,
  readEventRecords,
  readUnreadCount,
  writeCursor,
} = await jiti.import("./store.ts");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pi-web-events-"));
}

function record(overrides = {}) {
  return {
    receivedAt: new Date().toISOString(),
    cwd: "D:/proj",
    source: "Entity",
    eventType: "entity.transitioned",
    entityType: "MR",
    workspaceId: "ws_entity_base",
    state: "DEFINED",
    action: "notify",
    eventId: "1761466000000-0",
    data: { eventType: "entity.transitioned" },
    ...overrides,
  };
}

test("appends JSONL, assigns increasing seq, and reads back in order", () => {
  const dir = tempDir();
  const first = appendEventRecords([record(), record({ eventType: "entity.created" })], dir);
  assert.deepEqual(first.map((entry) => entry.seq), [1, 2]);

  const second = appendEventRecords([record({ eventType: "entity.updated" })], dir);
  assert.equal(second[0].seq, 3);

  const all = readEventRecords({ dir });
  assert.deepEqual(all.map((entry) => entry.seq), [1, 2, 3]);
  assert.equal(all[2].eventType, "entity.updated");
});

test("filters by workspace and keeps only the newest N", () => {
  const dir = tempDir();
  appendEventRecords([record({ cwd: "D:/a" }), record({ cwd: "D:/b" }), record({ cwd: "D:/a" })], dir);
  assert.deepEqual(readEventRecords({ dir, cwd: "D:/a" }).map((entry) => entry.seq), [1, 3]);
  assert.deepEqual(readEventRecords({ dir, cwd: "D:/a", limit: 1 }).map((entry) => entry.seq), [3]);
});

test("a torn last line is ignored instead of losing the whole log", () => {
  const dir = tempDir();
  appendEventRecords([record()], dir);
  const path = eventLogPath(dir);
  writeFileSync(path, `${readFileSync(path, "utf8")}{"seq":2,"cwd":"D:/pro`);
  const records = readEventRecords({ dir });
  assert.deepEqual(records.map((entry) => entry.seq), [1]);
});

test("oversized payloads are truncated, not written whole", () => {
  const dir = tempDir();
  const [written] = appendEventRecords([record({ data: { blob: "x".repeat(50_000) } })], dir);
  assert.equal(written.data.truncated, true);
  assert.ok(String(written.data.preview).length <= 16_385);
});

test("cursors round-trip per workspace and source", () => {
  const dir = tempDir();
  assert.equal(readCursor("D:/a", "Entity", dir), null);
  writeCursor("D:/a", "Entity", "1761466000000-0", dir);
  writeCursor("D:/b", "Entity", "1761466000000-9", dir);
  assert.equal(readCursor("D:/a", "Entity", dir), "1761466000000-0");
  assert.equal(readCursor("D:/b", "Entity", dir), "1761466000000-9");
});

test("an empty append writes nothing", () => {
  const dir = tempDir();
  assert.deepEqual(appendEventRecords([], dir), []);
  assert.deepEqual(readEventRecords({ dir }), []);
});

test("unread counts what arrived since the workspace was last shown", () => {
  const dir = tempDir();
  assert.equal(readUnreadCount("D:/a", dir), 0);

  appendEventRecords([record({ cwd: "D:/a" }), record({ cwd: "D:/a" }), record({ cwd: "D:/b" })], dir);
  assert.equal(readUnreadCount("D:/a", dir), 2);
  assert.equal(readUnreadCount("D:/b", dir), 1);

  // Opening the page marks only that workspace as seen.
  assert.equal(markWorkspaceSeen("D:/a", dir), 0);
  assert.equal(readUnreadCount("D:/a", dir), 0);
  assert.equal(readUnreadCount("D:/b", dir), 1);

  appendEventRecords([record({ cwd: "D:/a" })], dir);
  assert.equal(readUnreadCount("D:/a", dir), 1);
});
