import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// #157: after Next printed "Ready", the shell's identity probe went unanswered
// for over a minute and server.log said nothing. The launcher now records the
// first connection, the first request and its response, and event-loop stalls.
const fakeServer = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  // Hold the event loop the way a slow synchronous module load would.
  const until = Date.now() + 2600;
  while (Date.now() < until) {}
  response.statusCode = 204;
  response.end();
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  http.get({ host: "127.0.0.1", port, path: "/api/desktop/identity?x=1" }, (response) => {
    response.resume();
    response.on("end", () => setTimeout(() => process.exit(0), 600));
  });
});
`;

test("the launcher logs the first request, its response and event-loop stalls", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-launcher-timing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(rootDir, "desktop", "server-launcher.cjs"), join(dir, "desktop-server.cjs"));
  await writeFile(join(dir, "server.js"), fakeServer);

  const result = spawnSync(process.execPath, [join(dir, "desktop-server.cjs")], {
    env: {
      ...process.env,
      PI_WEB_PARENT_PID: String(process.pid),
      PI_DESKTOP_SPAWN_EPOCH_MS: String(Date.now()),
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const log = result.stderr;

  assert.match(log, /\[Entity Assistant\] launcher started \+\d+\.\ds \(node v/);
  // segment 1: process creation up to the launcher's first line
  assert.match(log, /\[Entity Assistant\] launcher reached \d+ ms after the shell spawned it/);
  // segment 2: loading Next + the pi SDK, before anything listens
  assert.match(log, /\[Entity Assistant\] next bootstrap took \d+ ms/);
  assert.match(log, /\[Entity Assistant\] first connection accepted \+\d+\.\ds/);
  // The query string is dropped: it may carry tokens.
  assert.match(log, /\[Entity Assistant\] first request GET \/api\/desktop\/identity received \+\d+\.\ds\n/);
  assert.match(log, /\[Entity Assistant\] first response 204 sent after \d+ ms/);
  assert.match(log, /\[Entity Assistant\] event loop blocked for \d+ ms \(ended \+\d+\.\ds\)/);
  // Only the first request is reported.
  assert.equal(log.match(/first request/g).length, 1);
});

// TASK-000113: the fine-grained probe is what turns "the window took 4 s" into
// "this request was answering while the loop was blocked for 1.4 s". It has to
// name the request, keep the query string out of the log, and report the
// request that was in flight when the tick saw the gap.
const probeServer = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  const until = Date.now() + 400;
  while (Date.now() < until) {}
  response.statusCode = 200;
  response.end("ok");
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  http.get({ host: "127.0.0.1", port, path: "/api/sessions/abc?force=1&token=secret" }, (response) => {
    response.resume();
    response.on("end", () => setTimeout(() => process.exit(0), 400));
  });
});
`;

test("the first-screen probe names each request and the stall it was in flight for", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-launcher-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(rootDir, "desktop", "server-launcher.cjs"), join(dir, "desktop-server.cjs"));
  await writeFile(join(dir, "server.js"), probeServer);

  const result = spawnSync(process.execPath, [join(dir, "desktop-server.cjs")], {
    env: { ...process.env, PI_WEB_PARENT_PID: String(process.pid), PI_FIRST_SCREEN_PROBE: "1" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const log = result.stderr;

  assert.match(log, /\[probe\] #1 GET \/api\/sessions\/abc start \+\d+ms inflight 1/);
  assert.match(log, /\[probe\] #1 GET \/api\/sessions\/abc done \+\d+ms dur [3-9]\d\dms status 200 inflight 0/);
  // The stall is attributed to the request that held the loop.
  assert.match(log, /\[probe\] stall [3-9]\d\dms ending \+\d+ms during #1 GET \/api\/sessions\/abc/);
  // Query strings can carry tokens; only the path may be logged.
  assert.ok(!log.includes("token=secret"), "the probe must not log query strings");
});

test("the probe stays off unless it is asked for", async (t) => {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-launcher-probe-off-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(rootDir, "desktop", "server-launcher.cjs"), join(dir, "desktop-server.cjs"));
  await writeFile(join(dir, "server.js"), probeServer);

  const result = spawnSync(process.execPath, [join(dir, "desktop-server.cjs")], {
    env: { ...process.env, PI_WEB_PARENT_PID: String(process.pid) },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stderr.includes("[probe]"), "a normal cold start must not print probe lines");
});
