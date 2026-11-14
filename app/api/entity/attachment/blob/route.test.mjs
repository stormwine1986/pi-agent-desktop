import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Step one of the upload channel (`SSR-000126` AC-5): content goes to the base's
// `POST /entity/blobs` through this proxy, with the credential of the server
// entry the panel read through. The route is a proxy and must stay one — the
// upstream URL is `entry + /blobs + ?category=`, never a URL the caller chose.
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

/** Requests the route made upstream, in order. */
let upstreamCalls = [];
let answer = () => new Response("{}", { status: 201 });

function stubBase() {
  upstreamCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    let body = init?.body;
    if (body instanceof ArrayBuffer) body = Buffer.from(body);
    upstreamCalls.push({ url, headers: { ...(init?.headers ?? {}) }, method: init?.method, body });
    return answer(url, init);
  };
}

async function project(t, servers) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-entity-blob-"));
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

async function upload(cwd, params, { bytes = Buffer.from("TMP bytes"), body = null, headers = {} } = {}) {
  const url = new URL("http://127.0.0.1/api/entity/attachment/blob");
  url.searchParams.set("cwd", cwd);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return route.POST(new Request(url, { method: "POST", body: body ?? bytes, headers }));
}

test.beforeEach(() => stubBase());

test("stores the content on the entry's own mount, with the entry's credential", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({
    blobId: "blob_abc123",
    sha256: "14fea7704c102aaa",
    size: 9,
    fileName: "note.pdf",
    contentType: "application/pdf",
    deduplicated: false,
  }), { status: 201 });

  // The panel sends multipart so the base sees the file's real media type: raw
  // bodies are only accepted as `application/octet-stream`, which would store an
  // opaque blob that the category's own `contentTypes` check then rejects.
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("TMP bytes")], { type: "application/pdf" }), "note.pdf");
  form.append("contentType", "application/pdf");

  const response = await upload(
    cwd,
    { server: "entity-base", category: "note", fileName: "note.pdf" },
    { body: form },
  );

  assert.equal(response.status, 201);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].method, "POST");
  // The URL is the entry's root plus the base's documented blob path.
  assert.equal(upstreamCalls[0].url, "http://base.example/entity/blobs?category=note&fileName=note.pdf");
  // The credential is the entry's, and the multipart body (boundary included) is
  // forwarded untouched, so the part keeps its name and its media type.
  assert.equal(upstreamCalls[0].headers.Authorization, "Bearer ak_test_token");
  assert.match(upstreamCalls[0].headers["content-type"], /^multipart\/form-data; boundary=/);
  const forwarded = Buffer.from(upstreamCalls[0].body).toString();
  assert.match(forwarded, /filename="note\.pdf"/);
  assert.match(forwarded, /Content-Type: application\/pdf/);
  assert.match(forwarded, /TMP bytes/);

  const body = await response.json();
  // The base answers `size`; the panel works in `fileSize` (the row's own name).
  assert.deepEqual(
    { blobId: body.blobId, sha256: body.sha256, fileSize: body.fileSize, step: body.step },
    { blobId: "blob_abc123", sha256: "14fea7704c102aaa", fileSize: 9, step: "content" },
  );
});

test("a caller-chosen url is ignored: the entry decides where content goes", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({ blobId: "blob_1" }), { status: 201 });

  await upload(cwd, {
    server: "entity-base",
    category: "note",
    url: "http://evil.example/steal",
    target: "http://evil.example/steal",
  });

  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "http://base.example/entity/blobs?category=note");
});

test("an absent category is the implicit default, exactly as the base reads it", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({ blobId: "blob_1" }), { status: 201 });

  await upload(cwd, { server: "entity-base" });

  assert.equal(upstreamCalls[0].url, "http://base.example/entity/blobs?category=default");
});

test("a category that could address another path never reaches the base", async (t) => {
  const cwd = await project(t, server());
  const response = await upload(cwd, { server: "entity-base", category: "../admin" });
  assert.equal(response.status, 400);
  assert.equal(upstreamCalls.length, 0);
  const body = await response.json();
  assert.equal(body.step, "content");
  assert.equal(body.retriable, false);
});

test("an idempotency key travels only when it is well formed", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({ blobId: "blob_1" }), { status: 201 });

  await upload(cwd, { server: "entity-base", category: "note" }, {
    headers: { "idempotency-key": "upload-blob-1" },
  });
  assert.equal(upstreamCalls[0].headers["idempotency-key"], "upload-blob-1");

  await upload(cwd, { server: "entity-base", category: "note" }, {
    headers: { "idempotency-key": "bad key with spaces" },
  });
  assert.equal(upstreamCalls[1].headers["idempotency-key"], undefined);
});

test("the base's 413 arrives as a readable, non-retriable content failure", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({
    code: "ATTACHMENT_TOO_LARGE",
    statusCode: 413,
    retriable: false,
    limitBytes: 20 * 1024 * 1024,
    message: "Attachment content exceeds the configured limit",
  }), { status: 413, headers: { "content-type": "application/json" } });

  const response = await upload(cwd, { server: "entity-base", category: "evidence", fileName: "big.zip" });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.step, "content");
  assert.equal(body.code, "ATTACHMENT_TOO_LARGE");
  assert.equal(body.statusCode, 413);
  assert.equal(body.retriable, false);
  assert.match(body.error, /上限/);
  assert.match(body.error, /20\.0 MB/);
});

test("storage being unavailable is retriable and says which step failed", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({
    code: "ATTACHMENT_STORAGE_UNAVAILABLE",
    statusCode: 503,
    retriable: true,
  }), { status: 503, headers: { "content-type": "application/json" } });

  const response = await upload(cwd, { server: "entity-base", category: "note" });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.retriable, true);
  assert.equal(body.step, "content");
  assert.match(body.error, /503/);
});

test("a base that answers without a blobId is a channel fault, not a silent success", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(JSON.stringify({ sha256: "abc" }), { status: 201 });

  const response = await upload(cwd, { server: "entity-base", category: "note" });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.code, "channel");
  assert.equal(body.retriable, true);
});

test("an unreachable entry is reported, never turned into a bare 500", async (t) => {
  const cwd = await project(t, server());
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };

  const response = await upload(cwd, { server: "entity-base", category: "note" });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.retriable, true);
  assert.match(body.error, /ECONNREFUSED/);
});
