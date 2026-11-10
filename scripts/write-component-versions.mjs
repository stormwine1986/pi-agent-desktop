import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { COMPONENT_MANIFEST_PATH, composeComponentManifest, componentManifestProblems } from "./component-manifest.mjs";
import { readLocalComponentVersions, rootDir } from "./release-components.mjs";

// SSR-000096 ②: the packaged manifest carries a `build` block so a package can
// be traced back to the commit it was built from. The block is composed from
// the checkout and the finished Next build, never from arguments, and it is
// re-read and checked after writing — a manifest that disagrees with
// `git rev-parse` / `git status` / `BUILD_ID` must fail here, not at install
// time.
//
// `--allow-missing-build-id` exists for the one caller that writes the
// manifest before any Next build (the component sync commit in
// .github/workflows/component-updates.yml). A release build never passes it.
const allowMissingBuildId = process.argv.includes("--allow-missing-build-id");

const destination = join(rootDir, COMPONENT_MANIFEST_PATH);
const manifest = await composeComponentManifest({
  root: rootDir,
  versions: await readLocalComponentVersions(),
  allowMissingBuildId,
});

await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(manifest, null, 2)}\n`);

const written = JSON.parse(await readFile(destination, "utf8"));
const problems = await componentManifestProblems(written, {
  root: rootDir,
  requireBuildId: !allowMissingBuildId,
});
if (problems.length > 0) {
  throw new Error(`component-versions.json is inconsistent with this checkout:\n- ${problems.join("\n- ")}`);
}

const { build } = written;
console.log(
  `Wrote ${COMPONENT_MANIFEST_PATH} for ${written.appVersion} ` +
    `(${build.gitCommitShort}${build.gitDirty ? "+dirty" : ""}, branch ${build.gitBranch}, ` +
    `build ${build.buildId ?? "not built yet"}, built ${build.builtAt}).`,
);
