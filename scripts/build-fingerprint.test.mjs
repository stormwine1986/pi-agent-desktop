import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUILD_FINGERPRINT_KEYS,
  BUILD_GENERATED_PATHS,
  assertPublicFingerprint,
  findFingerprintLeaks,
  fingerprintProblems,
  isIsoTimestampWithOffset,
  isoTimestampWithOffset,
  readGitFingerprint,
  readNextBuildId,
} from "./build-fingerprint.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function createRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-web-fingerprint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  writeFileSync(path.join(root, "README.md"), "hello\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  return root;
}

test("a clean checkout reports the commit and no dirty flag", async (t) => {
  const root = createRepo(t);
  const head = git(root, "rev-parse", "HEAD").trim();
  const fingerprint = await readGitFingerprint(root);

  assert.equal(fingerprint.gitCommit, head);
  assert.equal(fingerprint.gitCommitShort, head.slice(0, 7));
  assert.equal(fingerprint.gitBranch, "main");
  assert.equal(fingerprint.gitDirty, false);
});

test("an untracked file makes the tree dirty", async (t) => {
  // The reason this rule exists: a stray untracked file was copied into an
  // image, so the tag's sha no longer described what the artifact contained.
  const root = createRepo(t);
  writeFileSync(path.join(root, "notes.md"), "scratch\n");

  assert.equal((await readGitFingerprint(root)).gitDirty, true);
});

test("a modified tracked file makes the tree dirty", async (t) => {
  const root = createRepo(t);
  writeFileSync(path.join(root, "README.md"), "changed\n");

  assert.equal((await readGitFingerprint(root)).gitDirty, true);
});

test("the packaging pipeline's own outputs do not count as dirty", async (t) => {
  const root = createRepo(t);
  for (const relative of BUILD_GENERATED_PATHS) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), "{}\n");
  }

  // Without the exclusion every release build would claim to be dirty: the
  // manifest is this script's output and tauri.conf.json carries the updater
  // key injected from a CI secret.
  assert.equal((await readGitFingerprint(root)).gitDirty, false);

  writeFileSync(path.join(root, "README.md"), "changed\n");
  assert.equal((await readGitFingerprint(root)).gitDirty, true, "other files still count");
});

test("the Next build id is read from the staged build, or reported as missing", async (t) => {
  const root = createRepo(t);
  assert.equal(await readNextBuildId(root), null);

  mkdirSync(path.join(root, ".next-desktop"), { recursive: true });
  writeFileSync(path.join(root, ".next-desktop", "BUILD_ID"), "j_83oXsmFGVdK5TvnDckq\n");

  assert.equal(await readNextBuildId(root), "j_83oXsmFGVdK5TvnDckq");
});

test("the timestamp is ISO 8601 with an explicit offset", () => {
  const value = isoTimestampWithOffset(new Date("2026-11-10T07:35:04Z"));
  assert.equal(isIsoTimestampWithOffset(value), true, value);
  assert.match(value, /^2026-11-10T\d{2}:35:04(?:Z|[+-]\d{2}:\d{2})$/);
  assert.equal(isIsoTimestampWithOffset("2026-11-10T15:35:04"), false, "no zone");
  assert.equal(isIsoTimestampWithOffset("today"), false);
});

const CLEAN_BUILD = {
  gitCommit: "e0a8022a1b2c3d4e5f60718293a4b5c6d7e8f901",
  gitCommitShort: "e0a8022",
  gitBranch: "main",
  gitDirty: false,
  builtAt: "2026-11-10T15:35:04+08:00",
  node: "v22.22.2",
  buildId: "j_83oXsmFGVdK5TvnDckq",
};

test("a fingerprint of repository identity alone passes the leak gate", () => {
  assert.deepEqual(findFingerprintLeaks(CLEAN_BUILD), []);
  assert.deepEqual(fingerprintProblems(CLEAN_BUILD), []);
  assert.doesNotThrow(() => assertPublicFingerprint(CLEAN_BUILD));
});

test("local paths, tokens and private addresses are refused (AC-6)", () => {
  const leaks = [
    { label: "windows path", value: { gitBranch: "D:\\projects\\entity-assistant" } },
    { label: "posix home", value: { gitBranch: "/Users/evan/entity-assistant" } },
    { label: "github token", value: { buildId: "ghp_1234567890abcdefghij" } },
    { label: "private ip", value: { gitBranch: "10.8.0.125" } },
    { label: "credentialed url", value: { buildId: "https://user:pw@example.com" } },
    { label: "internal host", value: { node: "v22.22.2.example.internal" } },
  ];
  for (const { label, value } of leaks) {
    const build = { ...CLEAN_BUILD, ...value };
    assert.notDeepEqual(findFingerprintLeaks(build), [], `${label} must be reported`);
    assert.throws(() => assertPublicFingerprint(build), /leak/, label);
  }
});

test("the build block has a closed key set", () => {
  assert.equal(BUILD_FINGERPRINT_KEYS.length, 7);
  const withExtra = { ...CLEAN_BUILD, localPath: "/home/evan/build" };
  assert.throws(() => assertPublicFingerprint(withExtra), /may only carry/);
  assert.match(fingerprintProblems(withExtra).join("\n"), /build block must carry exactly/);
});

test("shape problems are reported instead of a package that cannot be traced", () => {
  const problems = fingerprintProblems({
    ...CLEAN_BUILD,
    gitCommit: "bc26571",
    gitDirty: "false",
    builtAt: "2026-11-10 15:35",
    node: "22",
  });
  const text = problems.join("\n");
  assert.match(text, /gitCommit is not a full sha/);
  assert.match(text, /gitDirty must be a boolean/);
  assert.match(text, /builtAt is not ISO 8601/);
  assert.match(text, /node is not a Node version/);
});
