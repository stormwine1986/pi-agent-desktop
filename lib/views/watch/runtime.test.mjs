import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * The two dispatch gates are only as good as their inputs (SSR-000089 ④⑦).
 *
 * Behaviour is covered by `pump.test.mjs` with stubs; these assertions pin the
 * wiring that stubs cannot: the running-session gate must read the app's own
 * registry (a resumed human session counts, a terminal process does not), and
 * the manual gate must count with the same state-substitution slice.
 */
test("the session gate reads the application registry, keyed by the target project", async () => {
  const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");

  assert.match(source, /hasBusyRpcSessionForCwd\(runCwd\)/);
  assert.doesNotMatch(source, /registry\.get\(/, "the pump's private index is not the determination source");
});

test("the manual gate counts with the claim slice, not a kind+state shortcut", async () => {
  const source = await readFile(new URL("./pump.ts", import.meta.url), "utf8");

  assert.match(source, /sliceDql\(view\.dql, watch\.claim\.from, watch\.claim\.manual\)/);
  assert.match(source, /deps\.projectBusy\(watch\.project\)/);
});

test("counting one row still asks for the total, so the panel can say N", async () => {
  const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");

  assert.match(source, /limit: 1/);
  assert.match(source, /includeTotal: true/);
});

/**
 * The dispatch order is only as good as what actually reaches the base: a key
 * list that is joined, truncated or dropped on the way would silently revert to
 * the old single-key query (SSR-000066 rev20, SSR-000089 rev33).
 */
test("the view's sort reaches the MCP list call untouched, key list included", async () => {
  const { createServer } = await import("node:http");
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createJiti } = await import("jiti");

  const root = await mkdtemp(join(tmpdir(), "watch-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const calls = [];
  const stub = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body || "{}");
      const reply = (payload) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (message.method === "initialize") {
        reply({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "watch-stub", version: "0" } },
        });
        return;
      }
      if (message.method !== "tools/call") {
        reply({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }
      calls.push({ name: message.params?.name, args: message.params?.arguments ?? {} });
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: JSON.stringify({ items: [{ key: "TASK-000001", revision: 1 }] }) }] },
      });
    });
  });

  try {
    await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const { port } = stub.address();
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    const project = join(root, "project");
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(
      join(project, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { stub: { type: "http", url: `http://127.0.0.1:${port}/mcp` } } }),
    );

    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const { createLiveDeps } = await jiti.import("./runtime.ts");
    const deps = createLiveDeps();
    const target = { panelCwd: project, server: "stub", workspace: "ws_test" };

    const listed = await deps.list(target, "type = 'TASK'", {
      limit: 7,
      orderBy: ["priority", "modified_at"],
      order: ["desc", "asc"],
    });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.value.length, 1);

    const call = calls.find((entry) => entry.name === "list");
    assert.ok(call, "the stub received no list call");
    assert.deepEqual(call.args.orderBy, ["priority", "modified_at"]);
    assert.deepEqual(call.args.order, ["desc", "asc"]);
    assert.equal(call.args.limit, 7);
    assert.equal(call.args.offset, 0);
    assert.equal(call.args.workspaceId, "ws_test");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await new Promise((resolve) => stub.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
