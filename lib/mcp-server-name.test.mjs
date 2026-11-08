import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { mcpServerKey, sameMcpServer } = await jiti.import("./mcp-server-name.ts");

test("a configured name and the name pi puts in tool names are the same server", () => {
  // The conversation called `mcp__entity_demo_system_evan__list`; `mcp.json`
  // names the entry `entity-demo-system-evan`. Both halves of the app — the
  // entity link and the views panel — compare these two strings.
  assert.equal(mcpServerKey("entity-demo-system-evan"), mcpServerKey("entity_demo_system_evan"));
  assert.equal(sameMcpServer("entity-demo-system-evan", "entity_demo_system_evan"), true);
  assert.equal(sameMcpServer("entity-demo-system-evan", "manhu-l100101"), false);
});

test("case is not a difference", () => {
  assert.equal(sameMcpServer("Entity-Base", "entity_base"), true);
});

test("a missing name matches nothing, rather than everything", () => {
  assert.equal(sameMcpServer(undefined, "entity-base"), false);
  assert.equal(sameMcpServer("entity-base", undefined), false);
  assert.equal(sameMcpServer(undefined, undefined), false);
  assert.equal(sameMcpServer("", ""), false);
});
