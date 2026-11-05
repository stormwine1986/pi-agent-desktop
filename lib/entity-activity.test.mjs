import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { parseMcpToolName, isEntityWriteTool, noteToolFinished, subscribeEntityWrites } =
  await jiti.import("./entity-activity.ts");

test("splits the server from the tool in pi's mcp__<server>__<tool> name", () => {
  assert.deepEqual(parseMcpToolName("mcp__entity-base__get"), { server: "entity-base", tool: "get" });
  assert.deepEqual(parseMcpToolName("mcp__manhu__transition"), { server: "manhu", tool: "transition" });
  // A tool name may contain the separator itself; it all belongs to the tool.
  assert.deepEqual(parseMcpToolName("mcp__s__a__b"), { server: "s", tool: "a__b" });
});

test("ignores names that are not MCP calls", () => {
  assert.equal(parseMcpToolName("bash"), null);
  assert.equal(parseMcpToolName("read"), null);
  assert.equal(parseMcpToolName("mcp__only-server"), null);
  assert.equal(isEntityWriteTool("bash"), false);
});

test("reads are not writes", () => {
  for (const tool of [
    "get", "list", "get_metadata", "inspect", "list_traces",
    "recall_similar_entities", "revision_diff", "baseline_diff", "show_user", "about_me",
    "get_trace_impact_subgraph",
  ]) {
    assert.equal(isEntityWriteTool(`mcp__entity-base__${tool}`), false, tool);
  }
});

test("state changes, edits and links are writes", () => {
  for (const tool of ["promotion", "update", "create", "link", "unlink", "merge_branch"]) {
    assert.equal(isEntityWriteTool(`mcp__entity-base__${tool}`), true, tool);
  }
});

test("a burst of writes to one server notifies once", async () => {
  const seen = [];
  const unsubscribe = subscribeEntityWrites((server) => seen.push(server));
  try {
    noteToolFinished("mcp__entity-base__update");
    noteToolFinished("mcp__entity-base__promotion");
    noteToolFinished("mcp__entity-base__get");
    assert.deepEqual(seen, [], "nothing is announced before the debounce elapses");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.deepEqual(seen, ["entity-base"]);
  } finally {
    unsubscribe();
  }
});

test("unsubscribed listeners stop receiving", async () => {
  const seen = [];
  const unsubscribe = subscribeEntityWrites((server) => seen.push(server));
  unsubscribe();
  noteToolFinished("mcp__other__update");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.deepEqual(seen, []);
});
