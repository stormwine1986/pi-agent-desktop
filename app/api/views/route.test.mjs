import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";

/**
 * `GET /api/views` against a stub MCP endpoint, so what is *sent* can be counted.
 *
 * SSR-000066 AC-2 is about the call that must not happen: a bad `orderBy` is a
 * configuration mistake, and paying for a failed query to discover it is the
 * defect. Counting `list` calls is the only way to see the difference between
 * "refused before asking" and "asked, then reported".
 */

const root = await mkdtemp(join(tmpdir(), "pi-web-views-route-"));
const agentDir = join(root, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(agentDir, { recursive: true });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { GET } = await jiti.import("./route.ts");

/** Every tool call the stub received, in order. */
const calls = [];
/** The type each request asks about, so one test cannot warm another's cache. */
const metadataByType = {
  ALPHA: [{ name: "name" }, { name: "owner" }],
  BETA: [{ name: "name" }],
  GAMMA: [{ name: "name" }, { name: "owner" }],
};
let metadataBroken = false;

const stub = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    const message = JSON.parse(body || "{}");
    const reply = (payload) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const text = (value) => reply({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: JSON.stringify(value) }] },
    });

    if (message.method === "initialize") {
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "views-stub", version: "0" },
        },
      });
      return;
    }
    if (message.method !== "tools/call") {
      reply({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }

    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    calls.push({ name, args });

    if (name === "get_metadata") {
      if (metadataBroken) {
        reply({ jsonrpc: "2.0", id: message.id, result: { isError: true, content: [{ type: "text", text: "metadata unavailable" }] } });
        return;
      }
      text({
        fields: metadataByType[args.type] ?? [],
        // The dispatch checks read the state machine, not only the field list:
        // a view is refused when its claim states are not reachable.
        lifecycle: {
          validStates: ["DONE", "DOING", "PARKED", "FREE"],
          routes: [{ from: "DONE", to: "DOING" }, { from: "DOING", to: "PARKED" }],
        },
      });
      return;
    }
    if (name === "list") {
      text({ items: [{ key: "TASK-000001", name: "一条", state: "DONE" }], total: 1 });
      return;
    }
    reply({ jsonrpc: "2.0", id: message.id, error: { message: `unknown tool ${name}` } });
  });
});

let project = "";

before(async () => {
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const { port } = stub.address();
  project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({
    mcpServers: { stub: { type: "http", url: `http://127.0.0.1:${port}/mcp` } },
  }));
  allowFileRoot(project);
});

after(async () => {
  await new Promise((resolve) => stub.close(resolve));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

async function evaluate(views) {
  await writeFile(join(project, ".pi", "views.yaml"), views);
  const response = await GET(new Request(`http://127.0.0.1/api/views?cwd=${encodeURIComponent(project)}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!body.error, JSON.stringify(body));
  return body.views;
}

const refused = (query, type) => `views:
  - title: 写错了
    server: stub
    workspace: ws_test
    dql: "type = '${type}' and state = 'DONE'"
    columns: [key]
    orderBy: ${query}
`;

test("a bad orderBy is refused locally, before any query is sent", async () => {
  const [view] = await evaluate(`${refused("modifed_at", "ALPHA")}\n  - title: 正常
    server: stub
    workspace: ws_test
    dql: "type = 'ALPHA' and state = 'DONE'"
    columns: [key]
    orderBy: owner
`);

  assert.match(view.error, /orderBy 指向的字段不存在：「modifed_at」/);
  assert.match(view.error, /owner/, "the message names what does exist");
  assert.match(view.error, /DQL：/, "the failing query travels with the reason");
  // One view, one query: the broken one never reached `list`.
  assert.deepEqual(calls.filter((call) => call.name === "list").map((call) => call.args.orderBy), ["owner"]);
  assert.equal(calls.filter((call) => call.name === "list").length, 1);
});

test("a spelling the base accepts is not refused", async () => {
  const [view] = await evaluate(`${refused("owner", "GAMMA")}`);
  assert.equal(view.error, null);
  assert.equal(view.rows.length, 1);
});

test("an unreadable type definition abstains instead of rejecting", async () => {
  metadataBroken = true;
  try {
    const [view] = await evaluate(`${refused("anything", "BETA")}`);
    assert.equal(view.error, null, "a metadata failure must not become a broken view");
    assert.equal(view.rows.length, 1, "the query still went out");
  } finally {
    metadataBroken = false;
  }
});

test("a view that does not sort never reads the type definition", async () => {
  const [view] = await evaluate(`views:
  - title: 不排序
    server: stub
    workspace: ws_test
    dql: "type = 'DELTA' and state = 'DONE'"
    columns: [key]
`);
  assert.equal(view.error, null);
  assert.equal(calls.some((call) => call.name === "get_metadata" && call.args.type === "DELTA"), false);
});

/**
 * SSR-000089 AC-11: the four dispatch states have to be readable from this
 * response alone. What the panel must never get is the same answer for "watched
 * and idle" and "not watched": that was the ambiguity the four indicators were
 * added for, and `watch: null` is how "not watched" is told apart.
 */
const watched = (title, claim, extra = "") => `  - title: ${title}
    server: stub
    workspace: ws_test
    dql: "type = 'ALPHA' and state = 'DONE'"
    columns: [key]
    watch:
      project: .
      prompt: .pi/mcp.json
      intervalSec: 60
      timeoutMin: 30
      claim:
        from: DONE
        to: DOING
        manual: ${claim}
${extra}`;

test("a view without dispatch says so by omission, not by an idle watch", async () => {
  const [view] = await evaluate(`views:
  - title: 只读
    server: stub
    workspace: ws_test
    dql: "type = 'ALPHA' and state = 'DONE'"
    columns: [key]
`);
  assert.equal(view.watch, null);
});

test("a paused view reports a reason instead of looking like an empty queue", async () => {
  const [view] = await evaluate(`views:
${watched("暂停了", "PARKED", "      enabled: false\n")}`);
  assert.equal(view.error, null);
  assert.ok(view.watch, "a watched view always names its dispatch state");
  assert.match(view.watch.disabled, /关闭了派发/);
  assert.equal(view.watch.skipped, null, "paused is not the same state as skipped");
});

test("a view held by the manual gate reports why it was skipped", async () => {
  const [view] = await evaluate(`views:
${watched("待人工挡着", "PARKED")}`);
  assert.equal(view.error, null);
  assert.equal(view.watch.disabled, null, "a gated view is not a broken view");
  assert.match(view.watch.skipped, /有 1 条待人工/, "the count comes from the same slice the pump uses");
});
