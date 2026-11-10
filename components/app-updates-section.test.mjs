import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (relative) => readFileSync(join(root, relative), "utf8");

/**
 * SSR-000096 ④: the interface and the endpoint must show the same value. The
 * only way to guarantee that is a single reader — the row asks the route, the
 * route reads the manifest. These assertions pin that shape so a later change
 * cannot start computing a second answer.
 */
test("the Version row asks the endpoint instead of computing a build id", () => {
  const source = read("components/AppUpdatesSection.tsx");

  assert.match(source, /fetch\("\/api\/app-info"/, "the row reads the endpoint");
  assert.match(source, /formatBuildLabel/, "the label comes from the shared formatter");
  assert.doesNotMatch(source, /NEXT_PUBLIC_/, "no build-time constant carries the identity");
  assert.doesNotMatch(source, /node:(?:child_process|fs)/, "the browser cannot read the manifest itself");
});

test("the endpoint exposes the manifest through the shared reader", () => {
  const route = read("app/api/app-info/route.ts");

  assert.match(route, /readAppInfo/, "the route reads the manifest, it does not invent a value");
  assert.match(route, /Cache-Control.*no-store/, "an overwrite install must not be masked by a cache");
});

test("exactly one module reads the packaged manifest", () => {
  // A second reader is how the interface and the API drift apart, and how a
  // commit ends up quoted from a stale copy.
  const readers = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative))) {
      const path = `${relative}/${entry}`;
      if (statSync(join(root, path)).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry) || /\.test\./.test(entry)) continue;
      if (readFileSync(join(root, path), "utf8").includes("component-versions.json")) {
        readers.push(path);
      }
    }
  };
  for (const dir of ["app", "components", "lib", "hooks"]) walk(dir);

  assert.deepEqual(readers, ["lib/app-build-info-server.ts"]);
});

test("the shell's stale check compares the commit, not only the version", () => {
  const rust = read("src-tauri/src/lib.rs");
  const start = rust.indexOf("fn stale_build_reason(");
  assert.ok(start > -1, "the comparison is a named function so it can be tested");

  const body = rust.slice(start, rust.indexOf("\n}\n", start));
  assert.match(body, /commit_full != installed\.commit_full/, "the commit is the deciding evidence");
  assert.match(body, /build_id != installed\.build_id/, "two packages of one commit differ only here");
  assert.match(body, /working tree/, "a dirty build is a different build");
  assert.doesNotMatch(body, /appVersion/, "comparing the product version alone detects nothing");

  // The identity is baked in at compile time; a runtime guess could report the
  // wrong build.
  assert.match(rust, /env!\("PI_AGENT_DESKTOP_GIT_COMMIT"\)/);
  const buildRs = read("src-tauri/build.rs");
  assert.match(buildRs, /cargo:rustc-env=PI_AGENT_DESKTOP_GIT_COMMIT=/);
  assert.match(buildRs, /cargo:rustc-env=PI_AGENT_DESKTOP_BUILD_ID=/);
  // Keep the Rust and JS exclusion lists identical: a mismatch makes a clean
  // release build report itself dirty.
  assert.match(buildRs, /"src-tauri\/resources\/component-versions\.json"/);
  assert.match(buildRs, /"src-tauri\/tauri\.conf\.json"/);
  const fingerprint = read("scripts/build-fingerprint.mjs");
  assert.match(fingerprint, /"src-tauri\/resources\/component-versions\.json"/);
  assert.match(fingerprint, /"src-tauri\/tauri\.conf\.json"/);
});
