import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPublicFingerprint,
  fingerprintProblems,
  isIsoTimestampWithOffset,
  isoTimestampWithOffset,
  readBundledNodeVersion,
  readGitFingerprint,
  readNextBuildId,
} from "./build-fingerprint.mjs";
import { createComponentManifest } from "./release-components.mjs";

/** Where the manifest lives inside the repository (and inside the installer). */
export const COMPONENT_MANIFEST_PATH = "src-tauri/resources/component-versions.json";

/**
 * Compose the manifest that ships inside the desktop package.
 *
 * The version half is `createComponentManifest()` (unchanged upstream shape);
 * `build` is the fingerprint from SSR-000096 ②. Every value is read from the
 * repository and the finished build tree at this moment — nothing is passed in
 * from the caller, so a manifest cannot claim a commit the checkout is not on.
 */
export async function composeComponentManifest({
  root,
  versions,
  now = new Date(),
  node,
  distDir,
  allowMissingBuildId = false,
  generatedPaths,
}) {
  const git = await readGitFingerprint(root, { generatedPaths });
  const buildId = await readNextBuildId(root, { distDir });
  if (!buildId && !allowMissingBuildId) {
    throw new Error(
      `No Next build id at ${distDir ?? ".next-desktop"}/BUILD_ID. ` +
        "Run `npm run desktop:prepare` first: the manifest must record the build the installer ships. " +
        "Pass --allow-missing-build-id only for a manifest that is not attached to a package (a component sync commit).",
    );
  }
  const build = {
    gitCommit: git.gitCommit,
    gitCommitShort: git.gitCommitShort,
    gitBranch: git.gitBranch,
    gitDirty: git.gitDirty,
    builtAt: isoTimestampWithOffset(now),
    node: node ?? (await readBundledNodeVersion(root)),
    buildId,
  };
  assertPublicFingerprint(build);
  return { ...createComponentManifest(versions), build };
}

export async function readComponentManifest(root, options = {}) {
  const path = join(root, options.manifestPath ?? COMPONENT_MANIFEST_PATH);
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * SSR-000096 ③: the manifest inside the artifact has to agree with the
 * repository state and with the `BUILD_ID` the packaged server runs. Returns
 * problem strings (empty means consistent) so both callers — the writer, right
 * after it writes, and the release gate — report the same way.
 *
 * `requireClean` is the release rule (⑤/AC-5): a dirty tree may be packaged for
 * a local experiment, but it may never produce a Release.
 */
export async function componentManifestProblems(manifest, {
  root,
  requireClean = false,
  requireBuildId = false,
  distDir,
  generatedPaths,
} = {}) {
  const problems = fingerprintProblems(manifest?.build);
  if (problems.length > 0) return problems;

  const build = manifest.build;
  const git = await readGitFingerprint(root, { generatedPaths });
  if (build.gitCommit !== git.gitCommit) {
    problems.push(`gitCommit is ${build.gitCommit} but HEAD is ${git.gitCommit}`);
  }
  if (build.gitCommitShort !== git.gitCommitShort) {
    problems.push(`gitCommitShort is ${build.gitCommitShort} but HEAD is ${git.gitCommitShort}`);
  }
  if (build.gitBranch !== git.gitBranch) {
    problems.push(`gitBranch is ${build.gitBranch} but the checkout is on ${git.gitBranch}`);
  }
  if (build.gitDirty !== git.gitDirty) {
    problems.push(
      `gitDirty is ${build.gitDirty} but the working tree is ${git.gitDirty ? "dirty" : "clean"}`,
    );
  }
  if (requireClean && build.gitDirty) {
    problems.push("gitDirty is true — a Release may only be built from a clean tree");
  }

  const buildId = await readNextBuildId(root, { distDir });
  if (requireBuildId && !buildId) {
    problems.push(`no BUILD_ID at ${distDir ?? ".next-desktop"}/BUILD_ID to compare with`);
  }
  if (buildId && build.buildId !== buildId) {
    problems.push(`buildId is ${build.buildId ?? "null"} but the staged build is ${buildId}`);
  }

  if (!isIsoTimestampWithOffset(build.builtAt)) {
    problems.push(`builtAt is not ISO 8601 with a timezone: ${build.builtAt}`);
  }
  return problems;
}
