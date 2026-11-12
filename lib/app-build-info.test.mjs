import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { findFingerprintLeaks } from "../scripts/build-fingerprint.mjs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { formatBuildLabel } = await jiti.import("./app-build-info.ts");
const { locateComponentManifest, normalizeBuild, readAppInfo } = await jiti.import(
  "./app-build-info-server.ts",
);
const { APP_VERSION } = await jiti.import("./branding.ts");

const BUILD = {
  gitCommit: "e0a8022a1b2c3d4e5f60718293a4b5c6d7e8f901",
  gitCommitShort: "e0a8022",
  gitBranch: "main",
  gitDirty: false,
  builtAt: "2026-11-10T15:35:04+08:00",
  node: "v22.22.2",
  buildId: "j_83oXsmFGVdK5TvnDckq",
};

const MANIFEST = {
  schemaVersion: 1,
  appVersion: "0.8.2",
  components: [
    { id: "pi-agent-desktop", repository: "stormwine1986/pi-agent-desktop", version: "0.8.2" },
    { id: "pi", repository: "earendil-works/pi", version: "1.5.0" },
    { id: "pi-web", repository: "agegr/pi-web", version: "0.10.0" },
  ],
  build: BUILD,
};

function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-web-app-info-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the Version label shows the product version and the short commit", () => {
  assert.equal(
    formatBuildLabel({ appVersion: "0.8.2", build: BUILD }),
    "0.8.2 · e0a8022",
  );
  assert.equal(
    formatBuildLabel({ appVersion: "0.8.2", build: { ...BUILD, gitDirty: true } }),
    "0.8.2 · e0a8022+dirty",
  );
  // Only the version part follows the display shortening rule (`0.8.0` -> `0.8`).
  assert.equal(
    formatBuildLabel({ appVersion: "0.8.0", build: BUILD }, "0.8"),
    "0.8 · e0a8022",
  );
  // No packaged manifest (a plain browser): the version is still true.
  assert.equal(formatBuildLabel({ appVersion: "0.8.2", build: null }), "0.8.2");
});

test("only fingerprint fields survive normalisation", () => {
  const build = normalizeBuild({ ...BUILD, localPath: "D:\\projects\\entity-assistant" });
  assert.deepEqual(Object.keys(build).sort(), [
    "buildId",
    "builtAt",
    "gitBranch",
    "gitCommit",
    "gitCommitShort",
    "gitDirty",
    "node",
  ]);
  // A build block without a commit is not an identity.
  assert.equal(normalizeBuild({ gitCommitShort: "e0a8022" }), null);
  assert.equal(normalizeBuild(null), null);
  // An installer that ships no build id still reports its commit.
  assert.equal(normalizeBuild({ ...BUILD, buildId: "" }).buildId, null);
});

test("the packaged manifest is found next to the server directory", (t) => {
  // Packaged: the Rust shell runs the server from `resources/server`.
  const root = tempDir(t);
  const serverDir = path.join(root, "server");
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(path.join(serverDir, "desktop-server.cjs"), "");
  writeFileSync(path.join(root, "component-versions.json"), JSON.stringify(MANIFEST));

  assert.equal(locateComponentManifest(serverDir), path.join(root, "component-versions.json"));
  assert.equal(
    locateComponentManifest(root),
    path.join(root, "component-versions.json"),
    "the resources directory itself works too",
  );

  // Nothing to find: a checkout (or a dev server) is not a package, and this
  // must never reach for a repository-relative path — a literal directory name
  // beside `process.cwd()` made Next's file tracer stage the whole `src-tauri`
  // tree into the standalone server.
  const empty = tempDir(t);
  assert.equal(locateComponentManifest(empty), null);
});

test("reading a manifest yields the version plus the build block", async (t) => {
  const dir = tempDir(t);
  const manifestPath = path.join(dir, "component-versions.json");
  writeFileSync(manifestPath, JSON.stringify(MANIFEST));

  const info = await readAppInfo({ manifestPath });
  assert.equal(info.appVersion, "0.8.2");
  assert.deepEqual(info.build, BUILD);

  // A missing or unreadable manifest is not an error: the running copy simply
  // is not a package.
  const missing = await readAppInfo({ manifestPath: path.join(dir, "nope.json") });
  assert.equal(missing.build, null);
  assert.match(missing.appVersion, /^\d+\.\d+\.\d+$/);
});

test("the committed manifest and the API payload leak nothing (AC-6)", async () => {
  const info = await readAppInfo({ manifestPath: path.resolve("src-tauri/resources/component-versions.json") });
  // Against the app version this checkout builds, not a literal: the committed
  // manifest is rewritten by every packaging run (TASK-000164 left it at 0.10.0
  // while this said 0.8.2), and the assertion that matters is "the manifest on
  // disk describes the app that ships".
  assert.equal(info.appVersion, APP_VERSION);
  assert.ok(info.build, "the committed manifest carries a build block");
  assert.deepEqual(findFingerprintLeaks(info.build), []);
  // The whole payload, not just the build block: a stray top-level field would
  // leave through the route as well.
  const payload = JSON.stringify(info);
  assert.doesNotMatch(payload, /[A-Za-z]:[\\/]/, "absolute Windows path");
  assert.doesNotMatch(payload, /\/(?:Users|home)\//, "POSIX home path");
  assert.doesNotMatch(payload, /\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "private address");
});
