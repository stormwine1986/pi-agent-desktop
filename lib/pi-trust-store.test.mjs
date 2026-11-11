import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { trustManager, TRUST_MANAGER_MODULE } = await jiti.import("./pi-trust-store.ts");
const sdk = await jiti.import("@earendil-works/pi-coding-agent");

// TASK-000113: the trust store is read from the SDK's own file instead of its
// package root, because the first screen's project-trust request loads it and
// the root is a 37 MB server-external graph (~1.4 s of blocked loop). That only
// works while the file exists, exports the same classes, and stays the same
// module instance the SDK root would give — a second copy would be a different
// `instanceof` and a different trust.json writer.

test("the trust manager loads from the SDK's own file", () => {
  const manager = trustManager();
  // Not `strictEqual` against the root's class: under jiti (this test's loader)
  // the file is required through jiti's own require while the root is imported
  // as ESM, so two instances are expected *here*. In the server both go through
  // Node's module system, where `require(esm)` returns the same instance an
  // `import()` does — `lib/pi-trust-store.mjs` in the packaged payload is the
  // evidence for that, and the route answering 200 rather than 500 is what
  // proves it. What this test can pin is the shape the server relies on.
  assert.equal(typeof manager.ProjectTrustStore, "function");
  assert.equal(typeof manager.hasTrustRequiringProjectResources, "function");
  assert.equal(typeof sdk.ProjectTrustStore, "function");
  assert.match(TRUST_MANAGER_MODULE, /^dist\/core\/trust-manager\.js$/);
  // Cached per process, like every other module here.
  assert.strictEqual(trustManager(), manager);
});

test("the file-loaded store reads trust.json exactly as the SDK's does", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-trust-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const project = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi", "mcp.json"), "{}");

  const ours = new (trustManager().ProjectTrustStore)(agentDir);
  const theirs = new sdk.ProjectTrustStore(agentDir);
  assert.equal(ours.getEntry(project), null);
  assert.equal(ours.get(project), null);

  theirs.set(project, true);
  assert.deepEqual(ours.getEntry(project), theirs.getEntry(project));
  assert.equal(ours.get(project), true);

  // An inherited decision resolves the same way through both.
  const nested = join(project, "packages", "inner");
  mkdirSync(nested, { recursive: true });
  assert.deepEqual(ours.getEntry(nested), theirs.getEntry(nested));
  assert.equal(ours.get(nested), true);
});
