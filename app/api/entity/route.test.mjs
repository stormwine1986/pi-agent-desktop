import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// A reply's `entity-item:` link names the server from the project that wrote it.
// Every person's `mcp.json` names its own endpoint (`entity-demo-system-alice`,
// `-evan`, or plain `entity-base`), so the same entity arrives here under a
// channel this project may not configure at all. These run the handler against a
// stubbed MCP endpoint to pin the resolution order: the named server first, then
// the rest, with the link's space breaking ties.
//
// See `pickTarget()` in route.ts — "a named channel this project does not
// configure is a hint, not a demand".
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");

/** Entities each stubbed endpoint answers with: url → key → entity. */
let entities = new Map();
/** Every tool call the handler made, in order: `${url} ${tool}`. */
let calls = [];
const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

/** A stand-in for the entity MCP server: one JSON-RPC endpoint, no network. */
function stubMcp() {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const body = JSON.parse(init?.body ?? "{}");
    const id = body.id ?? 0;
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });

    if (body.method === "initialize") {
      return rpcResponse(id, { protocolVersion: "2025-06-18" });
    }

    const tool = body.params?.name;
    calls.push(`${url} ${tool}`);
    if (body.method !== "tools/call") return rpcResponse(id, {});

    if (tool === "get") {
      const byKey = entities.get(url) ?? new Map();
      const entity = byKey.get(body.params.arguments?.id);
      if (!entity) return rpcResponse(id, { isError: true, content: [{ type: "text", text: "NOT_FOUND" }] });
      return rpcResponse(id, { structuredContent: entity });
    }
    if (tool === "get_metadata") {
      return rpcResponse(id, { structuredContent: { description: "系统需求", fields: [], lifecycle: {} } });
    }
    if (tool === "about_me") {
      return rpcResponse(id, { structuredContent: { userId: "evan", workspaceRoles: [] } });
    }
    return rpcResponse(id, { isError: true, content: [{ type: "text", text: `no tool ${tool}` }] });
  };
}

function rpcResponse(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", "mcp-session-id": "stub" },
  });
}

/** A project directory with the given `mcp.json` servers, plus an empty agent dir. */
async function project(t, servers) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-entity-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(Object.entries(servers).map(([name, url]) => [name, { url, type: "http" }])),
    }),
  );
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return cwd;
}

function entity(key, workspaceId) {
  return {
    id: key,
    key,
    type: "SSR",
    name: "示例",
    state: "DEFINED",
    revision: 1,
    workspaceId,
    fields: { name: "示例" },
    hiddenFields: [],
  };
}

async function read(cwd, params) {
  const url = new URL("http://127.0.0.1/api/entity");
  url.searchParams.set("cwd", cwd);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await route.GET(new Request(url));
  return { status: response.status, body: await response.json() };
}

test.beforeEach(() => {
  entities = new Map();
  calls = [];
  stubMcp();
});

test("opens through this project's own name when the link names another project's", async (t) => {
  const cwd = await project(t, { "entity-demo-system-evan": "http://demo.example/mcp" });
  entities.set("http://demo.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_entity_base")]]));

  const { status, body } = await read(cwd, {
    server: "entity-demo-system-alice",
    workspace: "ws_entity_base",
    key: "SSR-000033",
  });

  assert.equal(status, 200);
  // The configured spelling comes back, so every follow-up request names the real entry.
  assert.equal(body.server, "entity-demo-system-evan");
  assert.equal(body.workspace, "ws_entity_base");
});

test("keeps the named server when this project has it, even if another also holds the key", async (t) => {
  const cwd = await project(t, {
    "demo-a": "http://a.example/mcp",
    "demo-b": "http://b.example/mcp",
  });
  entities.set("http://a.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_alpha")]]));
  entities.set("http://b.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_beta")]]));

  const { status, body } = await read(cwd, { server: "demo-b", workspace: "ws_beta", key: "SSR-000033" });

  assert.equal(status, 200);
  assert.equal(body.server, "demo-b");
});

test("breaks a tie between stacks by the space the link carries", async (t) => {
  const cwd = await project(t, {
    "demo-a": "http://a.example/mcp",
    "demo-b": "http://b.example/mcp",
  });
  entities.set("http://a.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_alpha")]]));
  entities.set("http://b.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_beta")]]));

  // The channel is a stranger here, so the space is what is left to decide with.
  const { status, body } = await read(cwd, {
    server: "entity-demo-system-alice",
    workspace: "ws_beta",
    key: "SSR-000033",
  });

  assert.equal(status, 200);
  assert.equal(body.server, "demo-b");
  assert.equal(body.workspace, "ws_beta");
});

test("refuses to guess when several stacks hold the key and none matches the space", async (t) => {
  const cwd = await project(t, {
    "demo-a": "http://a.example/mcp",
    "demo-b": "http://b.example/mcp",
  });
  entities.set("http://a.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_alpha")]]));
  entities.set("http://b.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_beta")]]));

  const { status, body } = await read(cwd, {
    server: "entity-demo-system-alice",
    workspace: "ws_elsewhere",
    key: "SSR-000033",
  });

  assert.equal(status, 409);
  assert.equal(body.code, "channel");
  // Actionable: which servers answered, and the space that did not match.
  assert.match(body.error, /ws_alpha/);
  assert.match(body.error, /ws_beta/);
  assert.match(body.error, /ws_elsewhere/);
});

test("labels the entity with the space it actually lives in, not the one the link claims", async (t) => {
  // A stale link (or a same-named space in a second deployment) must not make a
  // readable entity pretend to be somewhere else: role checks and the panel's
  // space label are computed from this field.
  const cwd = await project(t, { "demo-a": "http://a.example/mcp" });
  entities.set("http://a.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_entity_base")]]));

  const { status, body } = await read(cwd, {
    server: "demo-a",
    workspace: "ws_somewhere_else",
    key: "SSR-000033",
  });

  assert.equal(status, 200);
  assert.equal(body.workspace, "ws_entity_base");
});

test("says what is configured when the named channel is absent and nothing holds the key", async (t) => {
  const cwd = await project(t, { "entity-base": "http://demo.example/mcp" });

  const { status, body } = await read(cwd, {
    server: "entity-demo-system-alice",
    workspace: "ws_entity_base",
    key: "SSR-000033",
  });

  assert.equal(status, 404);
  assert.equal(body.code, "channel");
  assert.match(body.error, /entity-demo-system-alice/);
  assert.match(body.error, /已配置：entity-base/);
  assert.match(body.error, /SSR-000033/);
});

test("does not describe a wiring failure as missing form metadata", async (t) => {
  // The panel keys its FM-META ① sentence off this code: a missing channel is not
  // "类型定义或实体没取到", and saying so sent the last reader down the wrong path.
  const cwd = await project(t, { "entity-base": "http://demo.example/mcp" });

  const { body } = await read(cwd, { server: "entity-demo-system-alice", key: "SSR-000033" });

  assert.equal(body.code, "channel");

  entities.set("http://demo.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_entity_base")]]));
  const ok = await read(cwd, { server: "entity-base", key: "SSR-000033" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, undefined);
});

test("reports a failed type definition as a metadata failure", async (t) => {
  const cwd = await project(t, { "entity-base": "http://demo.example/mcp" });
  entities.set("http://demo.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_entity_base")]]));

  const stub = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (body.method === "tools/call" && body.params?.name === "get_metadata") {
      return rpcResponse(body.id ?? 0, { isError: true, content: [{ type: "text", text: "TYPE_NOT_FOUND" }] });
    }
    return stub(input, init);
  };

  const { status, body } = await read(cwd, { server: "entity-base", key: "SSR-000033" });

  assert.equal(status, 502);
  assert.equal(body.code, "metadata");
});
