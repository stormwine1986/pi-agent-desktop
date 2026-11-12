import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(rootDir, "scripts", "verify-install.mjs");

// SSR-000095 AC-8: what an install says about itself has to be checkable from
// the outside — `resources/component-versions.json`, the Node runtime stamp and
// the runtime binary must agree, and a disagreement has to leave a non-zero
// exit code that names the item. AC-2's acceptance run uses the same entry.
const BUILD_ID = "verifyInstallBuildId1";
const NODE_BYTES = "not a runtime — verify-install only hashes this file\n";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function stage(t) {
  const dir = await mkdtemp(join(os.tmpdir(), "pi-verify-install-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const resources = join(dir, "resources");
  await mkdir(join(resources, "node"), { recursive: true });
  await mkdir(join(resources, "server", ".next-desktop"), { recursive: true });
  await writeFile(join(resources, "node", "node.exe"), NODE_BYTES);
  await writeFile(join(resources, "server", ".next-desktop", "BUILD_ID"), BUILD_ID);
  await writeFile(
    join(resources, "server", "node-runtime.json"),
    JSON.stringify({ node: "v22.22.2", sha256: sha256(NODE_BYTES) }, null, 2),
  );
  const manifest = {
    schemaVersion: 1,
    appVersion: "9.9.9",
    components: [{ id: "pi-agent-desktop", repository: "example/pi-agent-desktop", version: "9.9.9" }],
    build: {
      gitCommit: "0123456789abcdef0123456789abcdef01234567",
      gitCommitShort: "0123456",
      gitBranch: "main",
      gitDirty: false,
      builtAt: "2026-11-12T13:41:08+08:00",
      node: "v22.22.2",
      buildId: BUILD_ID,
    },
  };
  const manifestPath = join(resources, "component-versions.json");
  const runtimePath = join(resources, "server", "node-runtime.json");
  const buildIdPath = join(resources, "server", ".next-desktop", "BUILD_ID");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, resources, manifest, manifestPath, runtimePath, buildIdPath };
}

/** `--no-processes`: the fixture has no running binaries, and the test must not
 *  depend on whatever the machine happens to be running. */
function verify(dir, extraArgs = []) {
  return spawnSync(process.execPath, [script, "--dir", dir, "--no-processes", ...extraArgs], {
    encoding: "utf8",
    timeout: 120_000,
  });
}

test("a consistent install directory verifies with exit code 0", async (t) => {
  const { dir } = await stage(t);
  const result = verify(dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /node-sha256\s+ok/);
  assert.match(result.stdout, /node-version\s+ok/);
  assert.match(result.stdout, /buildId\s+ok/);
});

test("a forged node-runtime.json names the node version, not just the file", async (t) => {
  const { dir, runtimePath, manifest } = await stage(t);
  await writeFile(
    runtimePath,
    JSON.stringify({ node: "v0.0.0-forged", sha256: sha256(NODE_BYTES) }, null, 2),
  );
  const result = verify(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /node-version\s+FAIL/);
  assert.match(result.stdout, new RegExp(`v0\\.0\\.0-forged`));
  assert.match(result.stdout, new RegExp(manifest.build.node.replaceAll(".", "\\.")));
});

test("a forged gitCommit in the manifest is caught by its own short form", async (t) => {
  const { dir, manifestPath, manifest } = await stage(t);
  const forged = { ...manifest, build: { ...manifest.build, gitCommit: "f".repeat(40) } };
  await writeFile(manifestPath, JSON.stringify(forged, null, 2));
  const result = verify(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /gitCommit\s+FAIL/);
  assert.match(result.stdout, new RegExp(`f{40}`));
});

test("a swapped node.exe is caught by the recorded sha256", async (t) => {
  const { dir, resources } = await stage(t);
  await writeFile(join(resources, "node", "node.exe"), "a different runtime\n");
  const result = verify(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /node-sha256\s+FAIL/);
  assert.match(result.stdout, new RegExp(sha256("a different runtime\n")));
});

test("an install that never recorded a runtime hash fails instead of passing", async (t) => {
  const { dir, runtimePath } = await stage(t);
  await writeFile(runtimePath, JSON.stringify({ node: "v22.22.2" }, null, 2));
  const result = verify(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /node-sha256\s+FAIL/);
  assert.match(result.stdout, /no sha256 recorded/);
});

test("a server payload whose BUILD_ID disagrees with the manifest is a mixed install", async (t) => {
  const { dir, buildIdPath } = await stage(t);
  await writeFile(buildIdPath, "someOtherBuildId");
  const result = verify(dir);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /buildId\s+FAIL/);
  assert.match(result.stdout, /someOtherBuildId/);
});

test("the diagnostics section replays the installer's clean-up records", async (t) => {
  const { dir } = await stage(t);
  const logPath = join(dir, "desktop.log");
  await writeFile(
    logPath,
    [
      "2026-11-12T00:30:10.674Z startup v0.10.0 pid 24072 (windows)",
      "installer: action=install path=C:\\Entity Assistant\\resources\\node\\node.exe restart-manager=0 pids=pid:53228 strategy=shutdown-and-overwrite code=0",
      "2026-11-12T00:31:03.869Z server ready at http://127.0.0.1:38471/",
    ].join("\r\n"),
  );

  const result = verify(dir, ["--log", logPath]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Diagnostics/);
  assert.match(result.stdout, /installer: action=install/);
  assert.match(result.stdout, /pids=pid:53228/);
  assert.doesNotMatch(result.stdout, /server ready at/, "only clean-up records belong in the replay");
});
