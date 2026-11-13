import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Attachment content never travels through a tool call (`AR-000008` ②): the
// panel downloads over REST with the credential of the server entry it read
// through. This route is that hop — a proxy, and it must stay one: the URL comes
// from the entry plus the attachment id, never from the caller, or the entry's
// credential could be sent somewhere else.
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
/** What the stubbed base answers with next. */
let answer = () => new Response("bytes", { status: 200 });

function stubBase() {
  upstreamCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    upstreamCalls.push({ url, headers: { ...(init?.headers ?? {}) } });
    return answer(url, init);
  };
}

async function project(t, servers) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-entity-attachment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(path.join(cwd, ".pi"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "mcp.json"),
    JSON.stringify({ mcpServers: servers }),
  );
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

async function download(cwd, params, headers = {}) {
  const url = new URL("http://127.0.0.1/api/entity/attachment");
  url.searchParams.set("cwd", cwd);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return route.GET(new Request(url, { headers }));
}

test.beforeEach(() => stubBase());

test("streams the base's bytes with the entry's own credential", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response("TMP bytes", {
    status: 200,
    headers: {
      "content-type": "text/plain",
      "content-length": "9",
      etag: '"e70b20f1"',
      "accept-ranges": "bytes",
    },
  });

  const response = await download(cwd, {
    server: "entity-base",
    attachmentId: "att_945b5659ffef4688a5bbb2955b076eb8",
    name: "note.pdf",
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "TMP bytes");
  // The credential is the *entry's*, never the browser session's.
  assert.equal(upstreamCalls[0].headers.Authorization, "Bearer ak_test_token");
  // The path is built from the attachment id under the entry's own mount.
  assert.equal(upstreamCalls[0].url, "http://base.example/entity/attachments/att_945b5659ffef4688a5bbb2955b076eb8/content");
  // Caching headers come from the base; the save name comes from the panel's row.
  assert.equal(response.headers.get("etag"), '"e70b20f1"');
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-disposition"), /filename="note\.pdf"/);
});

test("a client-supplied url is ignored: the entry decides where the bytes come from", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response("ok", { status: 200 });

  await download(cwd, {
    server: "entity-base",
    attachmentId: "att_1",
    contentUrl: "http://evil.example/steal",
    url: "http://evil.example/steal",
  });

  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].url, "http://base.example/entity/attachments/att_1/content");
  assert.equal(upstreamCalls[0].headers.Authorization, "Bearer ak_test_token");
});

test("passes the historic view through to REST", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response("old bytes", { status: 200 });

  await download(cwd, { server: "entity-base", attachmentId: "att_1", revision: "3" });
  assert.equal(upstreamCalls[0].url, "http://base.example/entity/attachments/att_1/content?revision=3");

  await download(cwd, { server: "entity-base", attachmentId: "att_1", asOf: "2026-11-12T04:16:30Z" });
  assert.equal(
    upstreamCalls[1].url,
    "http://base.example/entity/attachments/att_1/content?asOf=2026-11-12T04%3A16%3A30.000Z",
  );

  // Both at once is refused rather than silently picking one — a dropped view
  // would save today's bytes under a history banner.
  const both = await download(cwd, { server: "entity-base", attachmentId: "att_1", revision: "3", asOf: "2026-11-12" });
  assert.equal(both.status, 400);
  assert.equal(upstreamCalls.length, 2);
});

test("forwards Range and relays 206, so a retry resumes", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response("0123456789", {
    status: 206,
    headers: {
      "content-range": "bytes 0-9/2580",
      "content-length": "10",
      "accept-ranges": "bytes",
      etag: '"sha"',
    },
  });

  const response = await download(
    cwd,
    { server: "entity-base", attachmentId: "att_1" },
    { range: "bytes=0-9", "if-none-match": '"sha"' },
  );

  assert.equal(upstreamCalls[0].headers.range, "bytes=0-9");
  assert.equal(upstreamCalls[0].headers["if-none-match"], '"sha"');
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-9/2580");
});

test("a 304 keeps the cache validator and carries no body", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response(null, { status: 304, headers: { etag: '"sha"' } });

  const response = await download(cwd, { server: "entity-base", attachmentId: "att_1" }, { "if-none-match": '"sha"' });
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("etag"), '"sha"');
  assert.equal(await response.text(), "");
});

test("every contract error keeps its status, code and retriable, and gains a sentence", async (t) => {
  const cwd = await project(t, server());
  const cases = [
    [403, { code: "PERMISSION_DENIED", statusCode: 403, retriable: false, message: "not authorized" }, /没有权限查看这个附件（403）/],
    [404, { code: "ATTACHMENT_NOT_FOUND", statusCode: 404, retriable: false }, /附件不存在/],
    [503, { code: "ATTACHMENT_STORAGE_UNAVAILABLE", statusCode: 503, retriable: true }, /存储暂时不可用（503）/],
    [413, { code: "ATTACHMENT_TOO_LARGE", statusCode: 413, retriable: false }, /大小上限（413）/],
  ];
  for (const [status, body, expected] of cases) {
    answer = () => new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
    const response = await download(cwd, { server: "entity-base", attachmentId: "att_1" });
    const payload = await response.json();
    assert.equal(response.status, status);
    assert.equal(payload.statusCode, status);
    assert.equal(payload.code, body.code);
    assert.equal(payload.retriable, body.retriable);
    assert.match(payload.error, expected);
  }
});

test("a non-json failure still answers in the contract's shape", async (t) => {
  const cwd = await project(t, server());
  answer = () => new Response("<html>gateway</html>", { status: 502 });

  const response = await download(cwd, { server: "entity-base", attachmentId: "att_1" });
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.statusCode, 502);
  assert.equal(payload.retriable, true);
  assert.match(payload.error, /服务器取附件时出错（502）/);
});

test("refuses a malformed attachment id instead of asking the base", async (t) => {
  const cwd = await project(t, server());
  const response = await download(cwd, { server: "entity-base", attachmentId: "../../admin" });
  assert.equal(response.status, 400);
  assert.equal(upstreamCalls.length, 0);
});

test("a missing channel is a wiring answer, not a download failure", async (t) => {
  const cwd = await project(t, server());
  const response = await download(cwd, { server: "not-configured", attachmentId: "att_1" });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.code, "channel");
  assert.equal(upstreamCalls.length, 0);
});

test("an unreachable base is retriable and says which entry failed", async (t) => {
  const cwd = await project(t, server());
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  const response = await download(cwd, { server: "entity-base", attachmentId: "att_1" });
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.retriable, true);
  assert.match(payload.error, /entity-base/);
});
