import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { findFingerprintLeaks } from "../../../scripts/build-fingerprint.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET } = await jiti.import("./route.ts");

const BUILD = {
  gitCommit: "e0a8022a1b2c3d4e5f60718293a4b5c6d7e8f901",
  gitCommitShort: "e0a8022",
  gitBranch: "main",
  gitDirty: true,
  builtAt: "2026-11-10T15:35:04+08:00",
  node: "v22.22.2",
  buildId: "j_83oXsmFGVdK5TvnDckq",
};

/**
 * The route locates the manifest relative to the working directory, so this
 * file runs it from a staged "packaged" layout: `server/` cwd with the manifest
 * beside it — exactly what the Rust shell sets up.
 */
async function inPackagedLayout(t, manifest) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-web-app-info-route-"));
  const previous = process.cwd();
  mkdirSync(path.join(root, "server"), { recursive: true });
  writeFileSync(path.join(root, "server", "desktop-server.cjs"), "");
  if (manifest) writeFileSync(path.join(root, "component-versions.json"), JSON.stringify(manifest));
  process.chdir(path.join(root, "server"));
  t.after(() => {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  });
}

test("GET /api/app-info returns the version and the full build block", async (t) => {
  const manifest = {
    schemaVersion: 1,
    appVersion: "0.8.2",
    components: [],
    build: BUILD,
  };
  await inPackagedLayout(t, manifest);

  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const payload = await response.json();
  assert.equal(payload.appVersion, "0.8.2");
  assert.deepEqual(payload.build, BUILD);
  assert.deepEqual(findFingerprintLeaks(payload.build), []);
});

test("GET /api/app-info reports no build when the copy is not a package", async (t) => {
  await inPackagedLayout(t, null);

  const payload = await (await GET()).json();
  assert.equal(payload.build, null);
  assert.match(payload.appVersion, /^\d+\.\d+\.\d+$/);
});
