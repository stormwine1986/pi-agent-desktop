import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Step two of the upload channel (`SSR-000126` AC-5 / AC-6): the stored blob is
// bound to the entity, which produces the new revision. A failure here has to
// read differently from a failure at the blob step — "403 at bind" means this
// category is frozen or the role is missing, not that content cannot be stored.
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const route = await jiti.import("./route.ts");

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

let upstreamCalls = [];
let answer = () => new Response("{}", { status: 201 });

function stubBase() {
  upstreamCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    upstreamCalls.push({ url, headers: { ...(init?.headers ?? {}) }, method: init?.method, body: init?.body });
    return answer(url, init);
  };
}

async function project(t, servers) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-entity-bind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(path.join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return cwd;
}

function server(url = "http://base.example/entity/mcp") {
  return {
    "entity-base": {
      url,
      type: "http",
      headers: { Authorization: "Bearer ak_test_token" },
    },
  };
}

async function bind(cwd, params, body, headers = {}) {
  const url = new URL("http://127.0.0.1/api/entity/attachment/bind");
  url.searchParams.set("cwd", cwd);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return route.POST(new Request(url, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  }));
}

test.beforeEach(() => stubBase());

test("binds the blob on the entry's own mount and returns the new revision", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({
    attachment: {
      id: "att_945b5659",
      category: "note",
      fileName: "note.pdf",
      sha256: "14fea7704c102aaa",
      sourceRevision: 7,
    },
    entityRevision: 7,
    replayed: false,
  }), { status: 201 });

  const response = await bind(
    cwd,
    { server: "entity-base", key: "TASK-000258" },
    { blobId: "blob_abc123", category: "note", fileName: "note.pdf" },
  );

  assert.equal(response.status, 201);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "http://base.example/entity/entities/TASK-000258/attachments");
  assert.equal(upstreamCalls[0].headers.Authorization, "Bearer ak_test_token");
  assert.equal(upstreamCalls[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(upstreamCalls[0].body), {
    blobId: "blob_abc123",
    category: "note",
    fileName: "note.pdf",
  });

  const body = await response.json();
  assert.equal(body.step, "bind");
  assert.equal(body.entityRevision, 7);
  assert.equal(body.attachment.id, "att_945b5659");
});

test("a blank file name is omitted, not sent as an empty string", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({ attachment: { id: "att_1" }, entityRevision: 3 }), { status: 201 });

  await bind(cwd, { server: "entity-base", key: "TASK-1" }, { blobId: "blob_1", category: "note", fileName: "   " });

  // An empty name is a 400 at the base; omitting it keeps the uploaded name.
  assert.deepEqual(JSON.parse(upstreamCalls[0].body), { blobId: "blob_1", category: "note" });
});

test("a key or blobId that could address another path never reaches the base", async (t) => {
  const cwd = await project(t, server());

  const slashKey = await bind(cwd, { server: "entity-base", key: "../../admin/users" }, { blobId: "blob_1" });
  assert.equal(slashKey.status, 400);
  assert.equal((await slashKey.json()).step, "bind");

  const badBlob = await bind(cwd, { server: "entity-base", key: "TASK-1" }, { blobId: "../../etc/passwd" });
  assert.equal(badBlob.status, 400);

  assert.equal(upstreamCalls.length, 0);
});

test("a body that is not JSON is refused before any call", async (t) => {
  const cwd = await project(t, server());
  const response = await bind(cwd, { server: "entity-base", key: "TASK-1" }, "not json");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "body");
  assert.equal(upstreamCalls.length, 0);
});

test("a frozen category answers 403 with the bind wording, not the content one", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({
    code: "PERMISSION_DENIED",
    statusCode: 403,
    retriable: false,
    message: "Not permitted to modify attachments for this entity type/state",
  }), { status: 403, headers: { "content-type": "application/json" } });

  const response = await bind(
    cwd,
    { server: "entity-base", key: "TASK-000258" },
    { blobId: "blob_abc123", category: "evidence", fileName: "evidence.pdf" },
  );

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.step, "bind");
  assert.equal(body.statusCode, 403);
  assert.equal(body.retriable, false);
  assert.match(body.error, /状态|角色/);
  assert.doesNotMatch(body.error, /不能上传附件内容/);
});

test("a content-type refusal names what the category accepts", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({
    code: "ATTACHMENT_CATEGORY_CONTENT_TYPE_UNSUPPORTED",
    statusCode: 415,
    retriable: false,
    acceptedContentTypes: ["application/pdf", "image/png"],
  }), { status: 415, headers: { "content-type": "application/json" } });

  const response = await bind(cwd, { server: "entity-base", key: "QAU-1" }, { blobId: "blob_1", category: "note" });
  const body = await response.json();
  assert.equal(body.code, "ATTACHMENT_CATEGORY_CONTENT_TYPE_UNSUPPORTED");
  assert.match(body.error, /application\/pdf \/ image\/png/);
});

test("a concurrent change is reported as a conflict the reader can act on", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({ code: "CONCURRENT_WRITE_CONFLICT", statusCode: 409, retriable: true }),
    { status: 409, headers: { "content-type": "application/json" } });

  const response = await bind(cwd, { server: "entity-base", key: "TASK-1" }, { blobId: "blob_1", category: "note" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /409/);
});

test("an answer without an attachment is a channel fault, not a silent success", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({ entityRevision: 7 }), { status: 201 });

  const response = await bind(cwd, { server: "entity-base", key: "TASK-1" }, { blobId: "blob_1", category: "note" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).retriable, true);
});

test("an idempotent replay keeps its 200 so a retry does not look like a new binding", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({ attachment: { id: "att_1" }, entityRevision: 5, replayed: true }),
    { status: 200, headers: { "content-type": "application/json" } });

  const response = await bind(cwd, { server: "entity-base", key: "TASK-1" }, { blobId: "blob_1", category: "note" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
});
