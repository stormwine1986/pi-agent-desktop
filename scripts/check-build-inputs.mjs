#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMPONENT_MANIFEST_PATH, componentManifestProblems, readComponentManifest } from "./component-manifest.mjs";
import { describePayloadScan, scanPayload } from "./packaged-payload.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The gate `tauri build` runs before it packages anything (TASK-000111).
 *
 * Why an assertion here and not `beforeBuildCommand: npm run desktop:prepare`:
 * every defence this repository has against a mixed or dirty package lives
 * *inside* `desktop:prepare` (it clears `src-tauri/target/<profile>/{resources,bundle}`,
 * prunes the traced `.pi/` and asserts the payload twice). A bare
 * `npx tauri build` / `cargo tauri build` skipped all of them: it packaged
 * whatever `src-tauri/resources` happened to hold — a server staged at an older
 * commit next to a shell compiled from today's tree — and the only staleness
 * check in the product (`stale_running_build()` in `src-tauri/src/lib.rs`)
 * compares `appVersion`, which is identical in exactly that case.
 *
 * Pointing the hook back at `desktop:prepare` would re-run a full Next build on
 * a tree that was just prepared (and in CI, where `release.yml` prepares once,
 * it would double the packaging job) unless a "am I already prepared?" guard
 * was added first — and that guard *is* this file. So the hook asserts instead:
 *
 * 1. `src-tauri/resources/component-versions.json` still describes this
 *    checkout — same `gitCommit`/`gitCommitShort`/`gitBranch`/`gitDirty`, and a
 *    `buildId` that matches the `.next-desktop/BUILD_ID` the staged payload was
 *    copied from. `prepare` does not rewrite the manifest, so the build entry
 *    (`npm run desktop:build`) writes it between the two steps, the ordering
 *    `release.yml` has always used.
 * 2. the staged payload carries a completed staging (`resources/server/server.js`
 *    + the `node-runtime.json` written after every prune and assertion pass).
 * 3. `scripts/packaged-payload.mjs` finds nothing under `src-tauri/resources`
 *    that must not ship — `.pi/`, a `Bearer ak_` key, an armoured private key,
 *    a nested `resources/server` or a `src-tauri/target` leftover. That is the
 *    DEFECT-000089 assertion, re-run on the path that skips `prepare`.
 *
 * Deliberately no env var, `--force` or `--skip`: a check that can be waved
 * through is not a check (DEFECT-000089), and this one has to hold for the
 * person typing `npx tauri build` with a stale `resources/` just as much as for
 * the release job.
 */

/** The directory `tauri build` copies into `target/<profile>/resources`. */
export const DESKTOP_PAYLOAD_ROOT = "src-tauri/resources";

/**
 * What a completed `desktop:prepare` leaves behind, relative to the payload
 * root. `node-runtime.json` is written after `bundleNodeRuntime()` — i.e. after
 * the prune, the nested-scope gate, the Windows path-length gate and the last
 * `assertPayloadClean()` — so its presence means staging finished, not that it
 * started.
 */
export const REQUIRED_STAGED_PATHS = Object.freeze([
  "server/server.js",
  "server/node-runtime.json",
  "component-versions.json",
]);

/** The documented build entry (`package.json`), used verbatim in the message. */
export const BUILD_ENTRY = "npm run desktop:build";

/** The two steps that entry runs before `tauri build`. */
export const PREPARE_STEPS = Object.freeze(["npm run desktop:prepare", "npm run release:manifest"]);

/** The actionable tail of every refusal. One vocabulary, everywhere. */
export function buildInputHint() {
  return [
    "The payload under src-tauri/resources and its `build` block are produced by",
    `${PREPARE_STEPS.map((step) => `\`${step}\``).join(" then ")}.`,
    `Run \`${BUILD_ENTRY}\` (both, then \`tauri build\`), or those two commands, then retry.`,
    "There is no skip switch: a package must not mix a server and a shell from different builds (SR-000033 ③).",
  ].join("\n");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything wrong with the inputs of a `tauri build`, as sentences (empty
 * means packageable). Kept separate from the printing so tests — and a future
 * caller — can read the verdict instead of matching log text.
 */
export async function findBuildInputProblems({ root = rootDir } = {}) {
  const problems = [];
  const payloadRoot = join(root, DESKTOP_PAYLOAD_ROOT);

  for (const relativePath of REQUIRED_STAGED_PATHS) {
    if (!(await exists(join(payloadRoot, relativePath)))) {
      problems.push(
        `${DESKTOP_PAYLOAD_ROOT}/${relativePath} is missing — no completed \`npm run desktop:prepare\` staged a payload here (or it was deleted/cleared).`,
      );
    }
  }

  let manifest = null;
  try {
    manifest = await readComponentManifest(root);
  } catch (error) {
    problems.push(
      `${COMPONENT_MANIFEST_PATH} is unreadable (${error?.code ?? error?.message ?? "unknown error"}) — nothing records which build would be packaged.`,
    );
  }

  if (manifest) {
    // The same comparison `release:verify` makes, plus a mandatory build id: a
    // package whose manifest disagrees with the checkout, or whose `buildId`
    // does not name the Next build inside `resources/server`, is the mix
    // SR-000033 ③ forbids and SSR-000096 ② exists to expose.
    problems.push(...(await componentManifestProblems(manifest, { root, requireBuildId: true })));
  }

  const scan = await scanPayload(payloadRoot);
  // A scan that saw nothing proves nothing (`assertPayloadClean` reasons the
  // same way): an empty or missing payload root would otherwise read as clean.
  if (scan.files === 0) {
    problems.push(
      `nothing to scan under ${DESKTOP_PAYLOAD_ROOT} (0 files) — an empty payload is not a clean payload.`,
    );
  }
  for (const finding of scan.findings) {
    problems.push(`[${finding.rule}] ${finding.path} — ${finding.describe}`);
  }

  return { problems, scan, manifest, payloadRoot };
}

/**
 * Throws when the payload must not be packaged. Prints what matched, because
 * the whole point is that the operator reads a fix, not a stack trace.
 */
export async function assertBuildInputs({
  root = rootDir,
  log = (message) => console.log(message),
  error = (message) => console.error(message),
} = {}) {
  const { problems, scan, manifest, payloadRoot } = await findBuildInputProblems({ root });

  if (problems.length === 0) {
    const { build } = manifest;
    log(
      `Desktop build inputs match this checkout: ${build.gitCommitShort}${build.gitDirty ? "+dirty" : ""} ` +
        `on ${build.gitBranch}, build ${build.buildId}, built ${build.builtAt}; ` +
        describePayloadScan(DESKTOP_PAYLOAD_ROOT, scan),
    );
    return;
  }

  error("Refusing to package: the inputs of this `tauri build` are not the ones this checkout's build produced.");
  // Print the scan line even on failure: "N files, 0 findings" and "N files, 3
  // findings" are different diagnoses, and the second one must not be mistaken
  // for a scan that never ran.
  error(describePayloadScan(DESKTOP_PAYLOAD_ROOT, scan));
  for (const problem of problems) error(`  - ${problem}`);
  error(buildInputHint());
  throw new Error(
    `${problems.length} build-input problem(s) under ${payloadRoot} — see above (TASK-000111, SR-000033 ③, DEFECT-000089).`,
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    await assertBuildInputs();
  } catch {
    // assertBuildInputs already wrote the reasons and the fix to stderr; the
    // exit code is what makes `tauri build` stop before it copies resources.
    process.exitCode = 1;
  }
}
