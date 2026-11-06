import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
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
