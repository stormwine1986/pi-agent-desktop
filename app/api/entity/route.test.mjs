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
/** The environment each stubbed endpoint declares: url → `serverInfo._meta`. */
let serverInfos = new Map();
/** Every tool call the handler made, in order: `${url} ${tool}`. */
let calls = [];
/** Every handshake the handler made, in order: url. */
let handshakes = [];
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
      handshakes.push(url);
      const meta = serverInfos.get(url);
      return rpcResponse(id, {
        protocolVersion: "2025-06-18",
        // A stub that declares nothing keeps the older-deployment path honest:
        // no `_meta` key at all, never `null` (ENV-ID 6).
        serverInfo: meta ? { name: "stub", version: "1.0.0", _meta: meta } : { name: "stub", version: "1.0.0" },
      });
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

/**
 * A project directory with the given `mcp.json` servers, plus an empty agent dir.
 * A value may be a url (plain entry) or a full entry, so a test can pin an
 * `instanceId` the way a deployment would.
 */
async function project(t, servers) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-entity-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "mcp.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(Object.entries(servers).map(([name, entry]) => [
        name,
        typeof entry === "string" ? { url: entry, type: "http" } : { type: "http", ...entry },
      ])),
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
  serverInfos = new Map();
  calls = [];
  handshakes = [];
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


// --- Environment identity (SSR-000092 / ENV-RESOLVE) -------------------------
//
// A link may carry the environment it was written against. That declaration
// selects, it never proves; only the endpoint's handshake proves, and only a
// pin (mcp.json or the link) can be compared with it.

/** Both stacks hold the same key in the same space — the case that used to be guessed. */
function twoStacks(servers) {
  for (const [url, meta] of Object.entries(servers)) {
    serverInfos.set(url, meta);
    entities.set(url, new Map([["SSR-000033", entity("SSR-000033", "ws_entity_base")]]));
  }
}

test("two environments with the same space and key open by declaration, not by luck", async (t) => {
  const cwd = await project(t, { "demo-a": "http://id1a.example/mcp", "demo-b": "http://id1b.example/mcp" });
  twoStacks({
    "http://id1a.example/mcp": { instanceId: "ins_demo", instanceName: "演示环境" },
    "http://id1b.example/mcp": { instanceId: "ins_test", instanceName: "测试环境" },
  });

  const { status, body } = await read(cwd, {
    server: "demo-a",
    workspace: "ws_entity_base",
    key: "SSR-000033",
    instanceId: "ins_test",
  });

  assert.equal(status, 200);
  // The declaration selected b even though the link's channel named a.
  assert.equal(body.server, "demo-b");
  assert.equal(body.identity.verdict, "verified");
  assert.equal(body.identity.instanceId, "ins_test");
  assert.equal(body.identity.instanceName, "测试环境");
  // Nothing probed a: a declaration does not need "read both and see".
  assert.equal(calls.includes("http://id1a.example/mcp get"), false);
});

test("the same environment under two entry names opens once, without a conflict", async (t) => {
  // AC-2: both entries point at one environment (two names, one instanceId).
  const cwd = await project(t, {
    "entity-base": "http://id2a.example/mcp",
    "entity-demo-system-evan": "http://id2two.example/mcp",
  });
  twoStacks({
    "http://id2a.example/mcp": { instanceId: "ins_demo" },
    "http://id2two.example/mcp": { instanceId: "ins_demo" },
  });

  const { status, body } = await read(cwd, {
    server: "entity-demo-system-evan",
    workspace: "ws_entity_base",
    key: "SSR-000033",
    instanceId: "ins_demo",
  });

  assert.equal(status, 200);
  assert.equal(body.identity.verdict, "verified");
  assert.equal(body.server, "entity-demo-system-evan");
});

test("a link that asks for an environment nobody declares is refused, listing both", async (t) => {
  const cwd = await project(t, { "demo-a": "http://id3a.example/mcp", "demo-b": "http://id3b.example/mcp" });
  twoStacks({
    "http://id3a.example/mcp": { instanceId: "ins_demo", instanceName: "演示环境" },
    "http://id3b.example/mcp": { instanceId: "ins_test", instanceName: "测试环境" },
  });

  const { status, body } = await read(cwd, {
    server: "demo-a",
    workspace: "ws_entity_base",
    key: "SSR-000033",
    instanceId: "ins_other",
  });

  assert.equal(status, 409);
  assert.equal(body.code, "instance-mismatch");
  assert.equal(body.expected, "ins_other");
  // Both environments are named, with their own ids: the reader can see the field.
  assert.match(body.error, /ins_demo/);
  assert.match(body.error, /ins_test/);
  assert.match(body.error, /INSTANCE_MISMATCH/);
  assert.match(body.error, /mcp\.json/);
  // A refused identity never reads the entity: nothing can "look opened".
  assert.equal(calls.some((call) => call.endsWith(" get")), false);
});

test("a link that disagrees with this project's pin is refused before any read", async (t) => {
  const cwd = await project(t, {
    "entity-base": { url: "http://id4a.example/mcp", instanceId: "ins_demo" },
  });
  twoStacks({ "http://id4a.example/mcp": { instanceId: "ins_demo", instanceName: "演示环境" } });

  const { status, body } = await read(cwd, {
    server: "entity-base",
    workspace: "ws_entity_base",
    key: "SSR-000033",
    instanceId: "ins_test",
  });

  assert.equal(status, 409);
  assert.equal(body.code, "instance-mismatch");
  assert.equal(body.expected, "ins_test");
  assert.equal(body.actual, "ins_demo");
  assert.match(body.error, /pin/);
});

test("a deployment pin that the endpoint does not match is refused", async (t) => {
  const cwd = await project(t, {
    "entity-base": { url: "http://id5a.example/mcp", instanceId: "ins_demo" },
  });
  twoStacks({ "http://id5a.example/mcp": { instanceId: "ins_test" } });

  const refused = await read(cwd, { server: "entity-base", workspace: "ws_entity_base", key: "SSR-000033" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.expected, "ins_demo");
  assert.equal(refused.body.actual, "ins_test");
});

test("a deployment pin that the endpoint matches verifies the open", async (t) => {
  const cwd = await project(t, {
    "entity-base": { url: "http://id5pin.example/mcp", instanceId: "ins_demo" },
  });
  twoStacks({ "http://id5pin.example/mcp": { instanceId: "ins_demo", instanceName: "演示环境" } });

  const ok = await read(cwd, { server: "entity-base", workspace: "ws_entity_base", key: "SSR-000033" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.identity.verdict, "verified");
  assert.equal(ok.body.identity.source, "config");
  assert.equal(ok.body.identity.instanceId, "ins_demo");
});

test("a declared environment with no comparator opens, marked 未验真 and not refused", async (t) => {
  // AC-5b: no pin and no declaration in the link means there is nothing to
  // compare — the panel must say so rather than claim verification.
  const cwd = await project(t, { "entity-base": "http://id6a.example/mcp" });
  twoStacks({ "http://id6a.example/mcp": { instanceId: "ins_demo" } });

  const { status, body } = await read(cwd, { server: "entity-base", workspace: "ws_entity_base", key: "SSR-000033" });

  assert.equal(status, 200);
  assert.equal(body.identity.verdict, "unverified");
  assert.equal(body.identity.instanceId, "ins_demo");
  assert.match(body.identity.detail, /未验真/);
});

test("an older deployment that declares nothing opens through the degraded path", async (t) => {
  // AC-3 / ENV-ID 6: no `_meta` at all is "未声明", and must not kill the stack.
  const cwd = await project(t, { "entity-base": "http://id7a.example/mcp" });
  entities.set("http://id7a.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_entity_base")]]));

  const { status, body } = await read(cwd, { server: "entity-base", workspace: "ws_entity_base", key: "SSR-000033" });

  assert.equal(status, 200);
  assert.equal(body.identity.verdict, "degraded");
  assert.equal(body.identity.instanceId, undefined);
  assert.match(body.identity.detail, /降级/);
});

test("an older deployment still refuses to pick one of several hits", async (t) => {
  const cwd = await project(t, { "demo-a": "http://id8a.example/mcp", "demo-b": "http://id8b.example/mcp" });
  entities.set("http://id8a.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_alpha")]]));
  entities.set("http://id8b.example/mcp", new Map([["SSR-000033", entity("SSR-000033", "ws_beta")]]));

  const { status, body } = await read(cwd, { key: "SSR-000033" });

  assert.equal(status, 409);
  assert.equal(body.code, "channel");
  assert.match(body.error, /ws_alpha/);
  assert.match(body.error, /ws_beta/);
  assert.match(body.error, /未声明身份/);
});

test("a declaration in the handshake that about_me contradicts is refused", async (t) => {
  const cwd = await project(t, { "entity-base": "http://id9a.example/mcp" });
  twoStacks({ "http://id9a.example/mcp": { instanceId: "ins_demo" } });

  const stub = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init?.body ?? "{}");
    if (body.method === "tools/call" && body.params?.name === "about_me") {
      return rpcResponse(body.id ?? 0, { structuredContent: { userId: "evan", instanceId: "ins_test" } });
    }
    return stub(input, init);
  };

  const { status, body } = await read(cwd, { server: "entity-base", workspace: "ws_entity_base", key: "SSR-000033" });

  assert.equal(status, 409);
  assert.equal(body.code, "instance-mismatch");
  assert.match(body.error, /about_me/);
});

test("a cached fingerprint costs one read per open and no second handshake", async (t) => {
  // AC-6: the declaration is remembered; opening the entity does not probe the
  // other configured entries and does not re-run the handshake.
  const cwd = await project(t, {
    "entity-base": { url: "http://id10a.example/mcp", instanceId: "ins_demo" },
    other: "http://id10b.example/mcp",
  });
  twoStacks({
    "http://id10a.example/mcp": { instanceId: "ins_demo" },
    "http://id10b.example/mcp": { instanceId: "ins_test" },
  });

  const first = await read(cwd, { server: "entity-base", workspace: "ws_entity_base", key: "SSR-000033" });
  assert.equal(first.status, 200);
  const second = await read(cwd, { server: "entity-base", workspace: "ws_entity_base", key: "SSR-000033" });
  assert.equal(second.status, 200);

  assert.equal(calls.filter((call) => call === "http://id10a.example/mcp get").length, 2);
  assert.equal(calls.includes("http://id10b.example/mcp get"), false);
  assert.equal(handshakes.filter((url) => url === "http://id10a.example/mcp").length, 1);
  // The other entry is not even handshaked: opening must not probe the project.
  assert.equal(handshakes.includes("http://id10b.example/mcp"), false);
});

test("changing the entry to another environment invalidates the cached identity", async (t) => {
  // "配置变更即失效": the same (cwd, server) now points at a different stack, so
  // the old instanceId must not be reused.
  const cwd = await project(t, { "entity-base": "http://id11a.example/mcp" });
  twoStacks({
    "http://id11a.example/mcp": { instanceId: "ins_demo" },
    "http://id11b.example/mcp": { instanceId: "ins_test" },
  });

  const before = await read(cwd, {
    server: "entity-base",
    workspace: "ws_entity_base",
    key: "SSR-000033",
    instanceId: "ins_demo",
  });
  assert.equal(before.status, 200);
  assert.equal(before.body.identity.instanceId, "ins_demo");

  await writeFile(
    path.join(cwd, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: { "entity-base": { url: "http://id11b.example/mcp", type: "http" } } }),
  );

  // The link still carries the old declaration: refused, because the endpoint
  // now declares the other environment.
  const stale = await read(cwd, {
    server: "entity-base",
    workspace: "ws_entity_base",
    key: "SSR-000033",
    instanceId: "ins_demo",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.actual, "ins_test");

  // And the new declaration opens, proving the fingerprint re-handshaked.
  const fresh = await read(cwd, {
    server: "entity-base",
    workspace: "ws_entity_base",
    key: "SSR-000033",
    instanceId: "ins_test",
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.identity.instanceId, "ins_test");
  assert.equal(handshakes.includes("http://id11b.example/mcp"), true);
});
