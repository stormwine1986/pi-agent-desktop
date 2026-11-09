import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  entityTabId,
  isEntityItemHref,
  openEntityItemLink,
  parseEntityItemHref,
  setEntityChannel,
  setEntityOpener,
} = await jiti.import("./entity-opener.ts");

test("the scheme is recognised whatever its case", () => {
  assert.equal(isEntityItemHref("entity-item:MR-000123"), true);
  assert.equal(isEntityItemHref("ENTITY-ITEM:MR-000123"), true);
  assert.equal(isEntityItemHref("https://example.com"), false);
  assert.equal(isEntityItemHref("file:///tmp/a.md"), false);
  assert.equal(isEntityItemHref(undefined), false);
});

test("a key alone is a link, so a reply need not repeat the channel", () => {
  assert.deepEqual(parseEntityItemHref("entity-item:MR-000123"), { key: "MR-000123" });
});

test("the full form names channel and space", () => {
  assert.deepEqual(
    parseEntityItemHref("entity-item:entity-base/ws_manhu/OR-000121"),
    { server: "entity-base", workspace: "ws_manhu", key: "OR-000121" },
  );
});

test("workspace and key without a channel is accepted", () => {
  assert.deepEqual(parseEntityItemHref("entity-item:ws_manhu/OR-000121"), { workspace: "ws_manhu", key: "OR-000121" });
});

test("an empty or keyless href is refused rather than guessed", () => {
  assert.equal(parseEntityItemHref("entity-item:"), null);
  assert.equal(parseEntityItemHref("entity-item:////"), null);
  assert.equal(parseEntityItemHref("https://example.com/MR-000123"), null);
});

test("a short link falls back to the channel used last", () => {
  const opened = [];
  const release = setEntityOpener((request) => opened.push(request));
  try {
    setEntityChannel({ server: "entity-base", workspace: "ws_manhu" });
    assert.equal(openEntityItemLink("entity-item:SR-000030"), true);
    assert.deepEqual(opened, [{ server: "entity-base", workspace: "ws_manhu", key: "SR-000030" }]);
  } finally {
    release();
  }
});

test("a channel-less link still opens, leaving the server to resolve it", () => {
  // The panel asks the project's servers which one holds the key, so a key the
  // model merely typed can be clicked too.
  const opened = [];
  const release = setEntityOpener((request) => opened.push(request));
  try {
    setEntityChannel({ server: "", workspace: "" });
    assert.equal(openEntityItemLink("entity-item:SR-000030"), true);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].key, "SR-000030");
    assert.equal(opened[0].server, "");
  } finally {
    release();
  }
});

test("with no opener registered, nothing claims to have opened", () => {
  assert.equal(openEntityItemLink("entity-item:entity-base/ws_manhu/SR-000030"), false);
});

test("one key in two projects is two tabs, because each has its own mcp.json", () => {
  // Both folders can hold the same conversation by way of a link, but only one of
  // them may answer for it: `entity-demo-system-alice` names the stack in the first
  // and nothing at all in the second. Sharing the tab made the *other* project's
  // error (or its token) answer for the folder the reader was actually in.
  const here = entityTabId("D:/projects/manhu-vv", "entity-demo-system-alice", "ws_entity_base", "SSYS-000002");
  const there = entityTabId("D:/projects/entity-build-center", "entity-demo-system-alice", "ws_entity_base", "SSYS-000002");
  assert.notEqual(here, there);
});

test("the same key in one project is one tab, whichever spelling named the server", () => {
  const fromReply = entityTabId("/repo", "entity_demo_system_alice", "ws_entity_base", "SSYS-000002");
  const fromList = entityTabId("/repo", "entity-demo-system-alice", "ws_entity_base", "SSYS-000002");
  assert.equal(fromReply, fromList);
});

test("a channel-less link still gets its own tab per project", () => {
  assert.equal(
    entityTabId("/repo", undefined, undefined, "MR-000123"),
    "entity:/repo:auto::MR-000123",
  );
  assert.notEqual(entityTabId("/repo", undefined, undefined, "MR-000123"), entityTabId("/other", undefined, undefined, "MR-000123"));
});
