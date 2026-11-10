/**
 * What a running build can say about itself (SSR-000096 ④).
 *
 * Types and formatting only, so the Settings row and the server route share one
 * definition without dragging `node:fs` into the client bundle. Reading the
 * manifest lives in `lib/app-build-info-server.ts`.
 *
 * The single source is the component manifest the installer put on disk (next
 * to the packaged server; `lib/app-build-info-server.ts` is the only reader).
 * The API route and the "Version" row both go through it, so the interface
 * cannot show a commit the API would not return — and neither can compute a
 * value of its own.
 */
export type AppBuildFingerprint = {
  /** Full git sha of the commit this package was built from. */
  gitCommit: string;
  /** First 7 characters, for display. */
  gitCommitShort: string;
  gitBranch: string;
  /** True when the tree had uncommitted changes at packaging time. */
  gitDirty: boolean;
  /** ISO 8601 with a timezone. */
  builtAt: string;
  /** The bundled Node runtime, e.g. `v22.22.2`. */
  node: string;
  /** Next's BUILD_ID: two packages of the same commit differ here. */
  buildId: string | null;
};

export type AppInfo = {
  /** Product version (`pi-agent-desktop`), independent of pi and pi-web. */
  appVersion: string;
  /** Null when the running copy is not a package (no manifest on disk). */
  build: AppBuildFingerprint | null;
};

/**
 * `0.8.2 · e0a8022`, with `+dirty` when the tree was not clean. The caller may
 * pass the short display form of the version (`0.8` for `0.8.0`), which is the
 * only part of this label that is presentation rather than identity.
 */
export function formatBuildLabel(info: AppInfo, displayVersion = info.appVersion): string {
  if (!info.build) return displayVersion;
  return `${displayVersion} · ${info.build.gitCommitShort}${info.build.gitDirty ? "+dirty" : ""}`;
}
