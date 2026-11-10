import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

/**
 * The classification lives in `core.ts` (pure, covered there); this file pins the
 * wiring that a pure test cannot: the server's typed error body has to survive
 * `callMcpTool` and reach `classifyPromotionFailure`, or a route-guard refusal is
 * recorded as "the tool is broken" again (TASK-000054).
 */

const root = mkdtempSync(join(tmpdir(), "watch-promote-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(
  join(agentDir, "mcp.json"),
  JSON.stringify({
    mcpServers: { "entity-base": { url: "http://stub.local/entity/mcp" } },
  }),
);

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const originalFetch = globalThis.fetch;
/** The `tools/call` result the stub answers with, per test. */
let toolResult = {};

globalThis.fetch = async (input, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  const id = body.id ?? 1;
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (body.method === "initialize") {
    return reply(id, { protocolVersion: "2025-06-18", serverInfo: { name: "stub", version: "1.0.0" } });
  }
  return reply(id, toolResult);
};

function reply(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { createLiveDeps } = await jiti.import("./runtime.ts");

const target = { panelCwd: root, server: "entity-base", workspace: "ws_entity_base" };

after(() => {
  globalThis.fetch = originalFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

test("a route-guard rejection reaches the pump as a skippable reason", async () => {
  toolResult = {
    isError: true,
    content: [
      {
        type: "text",
        text: "Error executing tool 'promotion': [STATE_GUARD_UNSATISFIED] Transition DRAFT → DEFINED on TASK TASK-000029 is blocked by route guard",
      },
    ],
    structuredContent: {
      code: "STATE_GUARD_UNSATISFIED",
      statusCode: 409,
      retriable: false,
      skippedByPolicy: true,
      message: "Transition DRAFT → DEFINED on TASK TASK-000029 is blocked by route guard",
      details: {
        route: { from: "DRAFT", to: "DEFINED" },
        entityType: "TASK",
        entityKey: "TASK-000029",
        relation: "depends_on",
        violations: [{ relation: "depends_on", key: "TASK-000029", state: "IN_PROGRESS", expected: ["FINISHED"] }],
      },
    },
  };

  const result = await createLiveDeps().promote(target, "TASK-000030", "DEFINED", 7);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, undefined, "a guard refusal is not a conflict");
  assert.equal(result.skip.code, "STATE_GUARD_UNSATISFIED");
  assert.equal(result.skip.reason, "条目依赖未完成（等待 TASK-000029）");
  assert.doesNotMatch(result.skip.reason, /STATE_GUARD|claim|intervalSec/);
});

test("a concurrent-write conflict keeps its conflict meaning end to end", async () => {
  toolResult = {
    isError: true,
    content: [{ type: "text", text: "Error executing tool 'promotion': [CONCURRENT_WRITE_CONFLICT] somebody else won" }],
    structuredContent: { code: "CONCURRENT_WRITE_CONFLICT", statusCode: 409, retriable: true },
  };

  const result = await createLiveDeps().promote(target, "TASK-000031", "DEFINED", 2);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.skip, undefined);
});

test("a real failure stays an error — no structured body, no whitelisted code", async () => {
  toolResult = {
    isError: true,
    content: [{ type: "text", text: "entity-base 返回 HTTP 502：bad gateway" }],
  };

  const result = await createLiveDeps().promote(target, "TASK-000032", "DEFINED", 2);
  assert.equal(result.ok, false);
  assert.equal(result.conflict, undefined);
  assert.equal(result.skip, undefined);
  assert.match(result.error, /502/);
});

test("a 4xx that is not a business refusal stays an error", async () => {
  toolResult = {
    isError: true,
    content: [{ type: "text", text: "Error executing tool 'promotion': [ENTITY_VALIDATION_FAILED] priority 不是有效值" }],
    structuredContent: { code: "ENTITY_VALIDATION_FAILED", statusCode: 400, retriable: false },
  };

  const result = await createLiveDeps().promote(target, "TASK-000033", "DEFINED", 2);
  assert.equal(result.ok, false);
  assert.equal(result.skip, undefined, "\"any 4xx is skippable\" would hide a bad write");
});
