import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUILD_ENTRY,
  DESKTOP_PAYLOAD_ROOT,
  assertBuildInputs,
  findBuildInputProblems,
} from "./check-build-inputs.mjs";
import { composeComponentManifest } from "./component-manifest.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSIONS = { "pi-agent-desktop": "0.8.2", pi: "1.5.0", "pi-web": "0.10.0" };

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    encoding: "utf8",
  });
}

/** A repository shaped like this one after `npm run desktop:prepare`. */
function createPreparedRepo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-web-build-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  writeFileSync(
    path.join(root, ".gitignore"),
    ".next-desktop/\nsrc-tauri/target/\nsrc-tauri/resources/server/\nsrc-tauri/resources/node/\n",
  );
  writeFileSync(path.join(root, "README.md"), "hello\n");
  mkdirSync(path.join(root, "src-tauri", "resources", "server"), { recursive: true });
  writeFileSync(path.join(root, "src-tauri", "resources", "component-versions.json"), "{}\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  stagePayload(root);
  return root;
}

function writeBuildId(root, value = "j_83oXsmFGVdK5TvnDckq") {
  mkdirSync(path.join(root, ".next-desktop"), { recursive: true });
  writeFileSync(path.join(root, ".next-desktop", "BUILD_ID"), `${value}\n`);
  return value;
}

/** What `prepare` stages: a server, the node-runtime marker written last. */
function stagePayload(root) {
  const server = path.join(root, DESKTOP_PAYLOAD_ROOT, "server");
  mkdirSync(server, { recursive: true });
  writeFileSync(path.join(server, "server.js"), "// standalone server\n");
  writeFileSync(path.join(server, "node-runtime.json"), `${JSON.stringify({ node: process.version })}\n`);
}

/** The manifest the build entry writes between `prepare` and `tauri build`. */
async function writeManifest(root) {
  const manifest = await composeComponentManifest({ root, versions: VERSIONS });
  writeFileSync(
    path.join(root, "src-tauri", "resources", "component-versions.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

test("a prepared checkout with an aligned manifest passes", async (t) => {
  const root = createPreparedRepo(t);
  writeBuildId(root);
  const manifest = await writeManifest(root);

  const { problems, scan } = await findBuildInputProblems({ root });
  assert.deepEqual(problems, []);
  assert.equal(scan.files, 3);
  assert.equal(manifest.build.gitCommit, git(root, "rev-parse", "HEAD").trim());

  const logged = [];
  await assertBuildInputs({ root, log: (line) => logged.push(line) });
  assert.match(logged.join("\n"), /Desktop build inputs match this checkout: [0-9a-f]{7}/);
});

test("a manifest from another commit is refused before packaging", async (t) => {
  const root = createPreparedRepo(t);
  writeBuildId(root);
  await writeManifest(root);
  writeFileSync(path.join(root, "README.md"), "still the same commit\n");
  git(root, "commit", "-am", "next commit");

  const problems = (await findBuildInputProblems({ root })).problems;
  const text = problems.join("\n");
  assert.match(text, /gitCommit is [0-9a-f]{40} but HEAD is [0-9a-f]{40}/);
  assert.match(text, /gitCommitShort is/);
});

test("a payload staged from a different Next build is refused", async (t) => {
  const root = createPreparedRepo(t);
  writeBuildId(root, "j_83oXsmFGVdK5TvnDckq");
  await writeManifest(root);
  // Someone re-ran the Next build (`npm run build` / a fresh prepare) without
  // rewriting the manifest, so the shipped server is no longer the recorded one.
  writeBuildId(root, "anotherBuildId000000");

  const text = (await findBuildInputProblems({ root })).problems.join("\n");
  assert.match(text, /buildId is j_83oXsmFGVdK5TvnDckq but the staged build is anotherBuildId000000/);
});

test("a tree that changed after the manifest was written is refused", async (t) => {
  const root = createPreparedRepo(t);
  writeBuildId(root);
  await writeManifest(root);
  writeFileSync(path.join(root, "notes.md"), "scratch\n");

  const text = (await findBuildInputProblems({ root })).problems.join("\n");
  assert.match(text, /gitDirty is false but the working tree is dirty/);
});

test("a credential planted in the staged payload fails the build, not just prepare", async (t) => {
  const root = createPreparedRepo(t);
  writeBuildId(root);
  await writeManifest(root);
  // AC-3: fingerprint aligned, so nothing but the payload scan can catch this.
  mkdirSync(path.join(root, DESKTOP_PAYLOAD_ROOT, ".pi"), { recursive: true });
  writeFileSync(
    path.join(root, DESKTOP_PAYLOAD_ROOT, ".pi", "mcp.json"),
    `${JSON.stringify({ mcpServers: { demo: { headers: { Authorization: "Bearer ak_NOTAREALKEY000000000000" } } } })}\n`,
  );

  const problems = (await findBuildInputProblems({ root })).problems;
  const text = problems.join("\n");
  assert.match(text, /\[local-config\] \.pi/);
  assert.match(text, /\[bearer-token\] \.pi\/mcp\.json/);

  await assert.rejects(
    () => assertBuildInputs({ root, log: () => {}, error: () => {} }),
    /build-input problem\(s\)/,
  );
});

test("an unstaged payload is refused instead of reading as clean", async (t) => {
  const root = createPreparedRepo(t);
  writeBuildId(root);
  await writeManifest(root);
  rmSync(path.join(root, DESKTOP_PAYLOAD_ROOT, "server"), { recursive: true, force: true });

  const text = (await findBuildInputProblems({ root })).problems.join("\n");
  assert.match(text, /src-tauri\/resources\/server\/server\.js is missing/);
  assert.match(text, /src-tauri\/resources\/server\/node-runtime\.json is missing/);
});

test("an empty payload root is not a clean payload", async (t) => {
  const root = createPreparedRepo(t);
  writeBuildId(root);
  await writeManifest(root);
  rmSync(path.join(root, DESKTOP_PAYLOAD_ROOT), { recursive: true, force: true });

  const text = (await findBuildInputProblems({ root })).problems.join("\n");
  assert.match(text, /nothing to scan under src-tauri\/resources \(0 files\)/);
});

test("the refusal names the documented build entry, with no skip switch", async () => {
  const errors = [];
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-web-build-inputs-empty-"));
  try {
    await assert.rejects(
      () => assertBuildInputs({ root, log: () => {}, error: (line) => errors.push(line) }),
      /see above/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const text = errors.join("\n");
  assert.match(text, new RegExp(`Run \`${BUILD_ENTRY}\``));
  assert.match(text, /npm run desktop:prepare/);
  assert.match(text, /npm run release:manifest/);
  assert.match(text, /no skip switch/);
});

test("`tauri build` runs the gate, on every platform, and CI prepares exactly once", () => {
  const read = (relative) => JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));
  const pkg = read("package.json");
  const gate = pkg.scripts["desktop:check-inputs"];

  assert.equal(gate, "node scripts/check-build-inputs.mjs");
  assert.equal(
    pkg.scripts["desktop:build"],
    "npm run desktop:prepare && npm run release:manifest && tauri build",
  );

  // The hook lives in the base config; Tauri merges `tauri.<platform>.conf.json`
  // over it, and neither platform file may point the hook somewhere else.
  const base = read("src-tauri/tauri.conf.json");
  assert.equal(base.build.beforeBuildCommand, "npm run desktop:check-inputs");
  for (const platform of ["windows", "linux"]) {
    const platformBuild = read(`src-tauri/tauri.${platform}.conf.json`).build ?? {};
    assert.equal(
      platformBuild.beforeBuildCommand ?? base.build.beforeBuildCommand,
      "npm run desktop:check-inputs",
      `tauri.${platform}.conf.json must inherit the build gate`,
    );
  }

  // Workflow files are CRLF on a Windows checkout and LF elsewhere; the counts
  // and the ordering below must not depend on which one this is.
  const readWorkflow = (file) => readFileSync(path.join(repoRoot, file), "utf8").replace(/\r\n/g, "\n");
  const count = (file, needle) => readWorkflow(file).split(needle).length - 1;
  // AC-4: the gate is an assertion, not a second prepare — the release job keeps
  // the one `desktop:prepare` it already had.
  assert.equal(count(".github/workflows/release.yml", "npm run desktop:prepare"), 1);
  assert.equal(count(".github/workflows/desktop-test-build.yml", "npm run desktop:prepare"), 1);
  // ...and both write the manifest after it, which is what the gate compares.
  assert.equal(count(".github/workflows/release.yml", "npm run release:manifest\n"), 1);
  assert.equal(count(".github/workflows/desktop-test-build.yml", "npm run release:manifest"), 1);

  // The ordering is the guarantee: prepare stages, the manifest names what was
  // staged, and only then does the shell get packaged.
  const assertOrder = (file, needles) => {
    const text = readWorkflow(file);
    const positions = needles.map((needle) => text.indexOf(needle));
    for (const position of positions) assert.ok(position >= 0, `${file} does not run ${needles[positions.indexOf(position)]}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${file} runs ${needles.join(" / ")} out of order`);
  };
  assertOrder(".github/workflows/release.yml", [
    "npm run desktop:prepare",
    "npm run release:manifest\n",
    "tauri-apps/tauri-action",
  ]);
  assertOrder(".github/workflows/desktop-test-build.yml", [
    "npm run desktop:prepare",
    "npm run release:manifest",
    "npx tauri build",
  ]);
});
