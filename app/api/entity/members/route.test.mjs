import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// `GET /api/entity/members` is the panel's only way to learn who may hold a
// `user` value (`SSR-000093` ②). These run it against a stubbed MCP endpoint so
// the three outcomes the field distinguishes — a list, an old deployment without
// the tool, and a bad request — are pinned.
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
/** Every tool call the handler made, in order: `${url} ${tool}`. */
let calls = [];
/** What the stubbed list_workspace_members answers. */
let answer = { kind: "ok", rows: [] };

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function rpcResponse(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", "mcp-session-id": "stub" },
  });
}

/** A stand-in for the entity MCP server: one JSON-RPC endpoint, no network. */
function stubMcp() {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const body = JSON.parse(init?.body ?? "{}");
    const id = body.id ?? 0;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "initialize") {
      return rpcResponse(id, { protocolVersion: "2025-06-18", serverInfo: { name: "stub", version: "1.0.0" } });
    }

    const tool = body.params?.name;
    calls.push(`${url} ${tool}`);
    if (body.method !== "tools/call") return rpcResponse(id, {});

    if (tool === "list_workspace_members") {
      if (answer.kind === "missing") {
        return rpcResponse(id, { isError: true, content: [{ type: "text", text: "Unknown tool: list_workspace_members" }] });
      }
      return rpcResponse(id, { structuredContent: answer.rows });
    }
    return rpcResponse(id, { isError: true, content: [{ type: "text", text: `no tool ${tool}` }] });
  };
}

/** A project directory with the given `mcp.json` servers, plus an empty agent dir. */
async function project(t, servers) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-members-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(Object.entries(servers).map(([name, url]) => [
        name,
        { url, type: "http" },
      ])),
    }),
  );
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return cwd;
}

async function read(params) {
  const url = new URL("http://127.0.0.1/api/entity/members");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await route.GET(new Request(url));
  return { status: response.status, body: await response.json() };
}

test.beforeEach(() => {
  calls = [];
  answer = { kind: "ok", rows: [] };
  stubMcp();
});

test("answers the member list the base declares, one row per person", async (t) => {
  const cwd = await project(t, { "entity-base": "http://demo.example/mcp" });
  answer = {
    kind: "ok",
    rows: [
      { username: "evan", displayName: "Evan Li", email: "evan@entity.com", roleName: "RD" },
      // Same person, another role: the field references the person.
      { username: "evan", email: "evan@entity.com", roleName: "PRODUCT" },
      { username: "alice", email: "alice@entity.com", roleName: "RD" },
    ],
  };

  const { status, body } = await read({ cwd, server: "entity-base", workspace: "ws_entity_base" });

  assert.equal(status, 200);
  assert.equal(body.workspace, "ws_entity_base");
  assert.deepEqual(body.members.map((member) => member.username), ["alice", "evan"]);
  assert.deepEqual(calls, ["http://demo.example/mcp list_workspace_members"]);
});

test("an old deployment without the tool is reported, not reported as nobody", async (t) => {
  const cwd = await project(t, { "entity-base": "http://demo.example/mcp" });
  answer = { kind: "missing" };

  const { status, body } = await read({ cwd, server: "entity-base", workspace: "ws_entity_base" });

  // The panel answers this by degrading to a text box with a visible note
  // (`SSR-000093` ⑦); an empty 200 list would hide that.
  assert.equal(status, 502);
  assert.equal(body.code, "members-unavailable");
  assert.match(body.error, /list_workspace_members/);
  assert.equal("members" in body, false);
});

test("a request without a workspace never reaches the base", async (t) => {
  const cwd = await project(t, { "entity-base": "http://demo.example/mcp" });

  const { status, body } = await read({ cwd, server: "entity-base" });

  assert.equal(status, 400);
  assert.match(body.error, /workspace is required/);
  assert.deepEqual(calls, []);
});

test("a server this project does not configure is a wiring answer", async (t) => {
  const cwd = await project(t, { "entity-base": "http://demo.example/mcp" });

  const { status, body } = await read({ cwd, server: "entity-demo-system-other", workspace: "ws_entity_base" });

  assert.equal(status, 400);
  assert.match(body.error, /entity-demo-system-other/);
  assert.deepEqual(calls, []);
});
