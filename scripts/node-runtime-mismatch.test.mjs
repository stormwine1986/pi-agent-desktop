import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

// DEFECT-000086: an overwrite install can leave the previous runtime next to
// the new server payload (NSIS "Ignore" on the locked node.exe). The launcher
// must refuse that mixed install instead of running new server code on an old
// Node, which used to surface later as Code mode / terminal doing nothing.
async function stage(t, stamp) {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-node-runtime-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(join(rootDir, "desktop", "server-launcher.cjs"), join(dir, "desktop-server.cjs"));
  await writeFile(join(dir, "server.js"), 'require("node:fs").writeFileSync("ran", "1");\n');
  if (stamp !== undefined) await writeFile(join(dir, "node-runtime.json"), JSON.stringify(stamp));
  return dir;
}

function launch(dir, { parentPid } = {}) {
  const env = { ...process.env };
  delete env.PI_WEB_PARENT_PID;
  if (parentPid !== undefined) env.PI_WEB_PARENT_PID = parentPid;
  return spawnSync(process.execPath, [join(dir, "desktop-server.cjs")], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("a runtime built with the announced Node version starts", async (t) => {
  const dir = await stage(t, { node: process.version });
  const result = launch(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, "ran")));
});

test("an old runtime next to a new payload is refused, with the fix in the log", async (t) => {
  const dir = await stage(t, { node: "v0.0.0-not-this-one" });
  const result = launch(dir);
  assert.equal(result.status, 1);
  assert.ok(!existsSync(join(dir, "ran")), "the server must not start");
  assert.match(result.stderr, /refusing to start/);
  assert.match(result.stderr, /v0\.0\.0-not-this-one/);
  assert.match(result.stderr, new RegExp(process.version.replaceAll(".", "\\.")));
  assert.match(result.stderr, /run the installer again/);
});

test("an install made before the stamp keeps starting", async (t) => {
  const dir = await stage(t);
  const result = launch(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, "ran")));
});

test("a launcher without a parent pid does not mistake it for an orphan", async (t) => {
  const dir = await stage(t, { node: process.version });
  await writeFile(
    join(dir, "server.js"),
    'setTimeout(() => require("node:fs").writeFileSync("ran", "1"), 1600);\n',
  );
  const result = launch(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, "ran")));
  assert.doesNotMatch(result.stderr, /desktop shell .* is gone|orphaned/);
});
