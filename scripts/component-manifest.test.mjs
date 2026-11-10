import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  composeComponentManifest,
  componentManifestProblems,
} from "./component-manifest.mjs";

const VERSIONS = { "pi-agent-desktop": "0.8.2", pi: "1.5.0", "pi-web": "0.10.0" };

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function createRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-web-manifest-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  writeFileSync(path.join(root, ".gitignore"), ".next-desktop/\n");
  writeFileSync(path.join(root, "README.md"), "hello\n");
  mkdirSync(path.join(root, "src-tauri", "resources"), { recursive: true });
  writeFileSync(path.join(root, "src-tauri", "resources", "component-versions.json"), "{}\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  return root;
}

function writeBuildId(root, value = "j_83oXsmFGVdK5TvnDckq") {
  mkdirSync(path.join(root, ".next-desktop"), { recursive: true });
  writeFileSync(path.join(root, ".next-desktop", "BUILD_ID"), `${value}\n`);
  return value;
}

test("the manifest records the commit, the tree state and the Next build id", async (t) => {
  const root = createRepo(t);
  const buildId = writeBuildId(root);
  const head = git(root, "rev-parse", "HEAD").trim();

  const manifest = await composeComponentManifest({ root, versions: VERSIONS });

  assert.equal(manifest.appVersion, "0.8.2");
  assert.deepEqual(
    manifest.components.map((component) => component.id),
    ["pi-agent-desktop", "pi", "pi-web"],
  );
  assert.equal(manifest.build.gitCommit, head);
  assert.equal(manifest.build.gitCommitShort, head.slice(0, 7));
  assert.equal(manifest.build.gitBranch, "main");
  assert.equal(manifest.build.gitDirty, false);
  assert.equal(manifest.build.buildId, buildId);
  assert.match(manifest.build.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/);
  assert.deepEqual(await componentManifestProblems(manifest, { root }), []);
});

test("a manifest is refused without a build id unless the caller says so", async (t) => {
  const root = createRepo(t);

  await assert.rejects(
    () => composeComponentManifest({ root, versions: VERSIONS }),
    /No Next build id/,
  );

  // The component-sync commit writes the manifest before any Next build; that
  // copy is never the one inside an installer.
  const manifest = await composeComponentManifest({
    root,
    versions: VERSIONS,
    allowMissingBuildId: true,
  });
  assert.equal(manifest.build.buildId, null);
  assert.match(
    (await componentManifestProblems(manifest, { root, requireBuildId: true })).join("\n"),
    /no BUILD_ID/,
  );
});

test("a dirty tree is recorded, and a Release is refused (AC-2 / AC-5)", async (t) => {
  const root = createRepo(t);
  writeBuildId(root);
  writeFileSync(path.join(root, "uncommitted.txt"), "local experiment\n");

  const manifest = await composeComponentManifest({ root, versions: VERSIONS });
  assert.equal(manifest.build.gitDirty, true);

  const localProblems = await componentManifestProblems(manifest, { root });
  assert.deepEqual(localProblems, [], "packaging a dirty tree locally is allowed but recorded");

  const releaseProblems = await componentManifestProblems(manifest, { root, requireClean: true });
  assert.match(releaseProblems.join("\n"), /a Release may only be built from a clean tree/);
});

test("a manifest that disagrees with git or the build is reported", async (t) => {
  const root = createRepo(t);
  writeBuildId(root);
  const manifest = await composeComponentManifest({ root, versions: VERSIONS });

  const wrongCommit = structuredClone(manifest);
  wrongCommit.build.gitCommit = "0".repeat(40);
  assert.match(
    (await componentManifestProblems(wrongCommit, { root })).join("\n"),
    /gitCommit is 0{40} but HEAD is/,
  );

  const wrongBuild = structuredClone(manifest);
  wrongBuild.build.buildId = "k_somethingElse";
  assert.match(
    (await componentManifestProblems(wrongBuild, { root })).join("\n"),
    /buildId is k_somethingElse but the staged build is/,
  );

  const wrongDirty = structuredClone(manifest);
  wrongDirty.build.gitDirty = true;
  assert.match(
    (await componentManifestProblems(wrongDirty, { root })).join("\n"),
    /gitDirty is true but the working tree is clean/,
  );
});

test("the manifest cannot carry a machine-local detail (AC-6)", async (t) => {
  const root = createRepo(t);
  writeBuildId(root);
  // A branch name is the one free-form string in the block; keeping it a plain
  // ref name is what makes "no local path" structural rather than a promise.
  git(root, "checkout", "-b", "release/0.8.2");

  const manifest = await composeComponentManifest({ root, versions: VERSIONS });
  assert.equal(manifest.build.gitBranch, "release/0.8.2");
  assert.deepEqual(await componentManifestProblems(manifest, { root }), []);
  assert.equal(JSON.stringify(manifest).includes(root.replace(/\\/g, "\\\\")), false);
});
