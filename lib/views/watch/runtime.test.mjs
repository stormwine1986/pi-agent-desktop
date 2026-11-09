import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * The two dispatch gates are only as good as their inputs (SSR-000089 ④⑦).
 *
 * Behaviour is covered by `pump.test.mjs` with stubs; these assertions pin the
 * wiring that stubs cannot: the running-session gate must read the app's own
 * registry (a resumed human session counts, a terminal process does not), and
 * the manual gate must count with the same state-substitution slice.
 */
test("the session gate reads the application registry, keyed by the target project", async () => {
  const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");

  assert.match(source, /hasBusyRpcSessionForCwd\(runCwd\)/);
  assert.doesNotMatch(source, /registry\.get\(/, "the pump's private index is not the determination source");
});

test("the manual gate counts with the claim slice, not a kind+state shortcut", async () => {
  const source = await readFile(new URL("./pump.ts", import.meta.url), "utf8");

  assert.match(source, /sliceDql\(view\.dql, watch\.claim\.from, watch\.claim\.manual\)/);
  assert.match(source, /deps\.projectBusy\(watch\.project\)/);
});

test("counting one row still asks for the total, so the panel can say N", async () => {
  const source = await readFile(new URL("./runtime.ts", import.meta.url), "utf8");

  assert.match(source, /limit: 1/);
  assert.match(source, /includeTotal: true/);
});
