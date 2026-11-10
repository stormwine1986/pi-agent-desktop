import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The build fingerprint that travels inside every packaged desktop app
 * (`src-tauri/resources/component-versions.json` → `build`).
 *
 * A version number identifies a release, never a build: 0.8.2 shipped twice
 * from different commits (and twice from the same commit on different days)
 * and nothing in the product could tell them apart (SSR-000096). This block is
 * what makes a package answerable: which commit, which branch, was the tree
 * clean, when, with which Node, and — the one value that distinguishes two
 * packages built from the same commit — the Next `BUILD_ID` that the packaged
 * server actually runs.
 *
 * It is also the leak boundary (AC-6): only repository identity may be
 * recorded. No absolute path (the builder's checkout), no token, no private
 * host. `assertPublicFingerprint()` enforces that structurally — the key set is
 * closed and every value has to survive a scan for paths, credentials and
 * private addresses — instead of relying on whoever edits this file.
 */

/** Exactly the keys a `build` block may carry. Nothing else may be added. */
export const BUILD_FINGERPRINT_KEYS = Object.freeze([
  "buildId",
  "builtAt",
  "gitBranch",
  "gitCommit",
  "gitCommitShort",
  "gitDirty",
  "node",
]);

/**
 * Files the packaging pipeline itself writes, which therefore never make the
 * tree "dirty" in the sense this fingerprint reports:
 *
 * - `component-versions.json` is this script's output; writing it is how the
 *   fingerprint gets into the package at all.
 * - `tauri.conf.json` gets the updater public key injected from a CI secret
 *   (the committed value is deliberately empty, see
 *   `scripts/configure-updater-public-key.mjs`), so a release build always
 *   shows it as modified.
 *
 * Anything else — a modified tracked file, or an untracked file that is not
 * ignored — counts as dirty. The untracked case is not theoretical: a stray
 * `COPY docs/` in the Dockerfile pulled untracked notes into an image and made
 * the tag's sha a false witness (TASK-000042).
 */
export const BUILD_GENERATED_PATHS = Object.freeze([
  "src-tauri/resources/component-versions.json",
  "src-tauri/tauri.conf.json",
]);

export const DEFAULT_DESKTOP_DIST_DIR = ".next-desktop";

function git(root, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim();
        reject(new Error(`git ${args.join(" ")} failed in ${root}: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * `git status --porcelain` covering untracked files, minus the paths the build
 * itself generates. Kept as one function so the writer, the release gate and
 * the tests cannot disagree about what "dirty" means.
 */
export async function readGitFingerprint(root, options = {}) {
  const generated = options.generatedPaths ?? BUILD_GENERATED_PATHS;
  const porcelainArgs = ["status", "--porcelain", "--untracked-files=all"];
  if (generated.length > 0) {
    // A single `--` followed by every exclusion: repeating `--` between
    // pathspecs makes git treat the rest as literal paths and silently report
    // a clean tree.
    porcelainArgs.push("--", ...generated.map((path) => `:(exclude)${path}`));
  }
  // `--` before the pathspecs: without it git prefers the excluded path as a
  // revision, which fails only in repositories whose branch has that name.
  const [head, short, status, symbolic] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["rev-parse", "--short=7", "HEAD"]),
    git(root, porcelainArgs),
    git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
  ]);

  return {
    gitCommit: head.trim(),
    gitCommitShort: short.trim(),
    gitBranch: readBranch(symbolic),
    gitDirty: status
      .split("\n")
      .some((line) => line.trim().length > 0),
  };
}

/**
 * A CI release checks out a tag, so `symbolic-ref` says nothing. The ref name
 * the runner reports is the same kind of identifier (a branch or tag name,
 * which is public by definition), so it is a safe fallback.
 */
function readBranch(symbolic) {
  const branch = symbolic.trim();
  if (branch) return branch;
  const fromCi = process.env.GITHUB_REF_NAME?.trim();
  if (fromCi) return fromCi;
  return "detached";
}

/** The Next build id the packaged server will report, or null before a build. */
export async function readNextBuildId(root, options = {}) {
  const distDir = options.distDir ?? DEFAULT_DESKTOP_DIST_DIR;
  try {
    const raw = await readFile(join(root, distDir, "BUILD_ID"), "utf8");
    const buildId = raw.trim();
    return buildId.length > 0 ? buildId : null;
  } catch {
    return null;
  }
}

/**
 * The Node runtime the installer bundles: `desktop:prepare` copies
 * `process.execPath` and records its version, so prefer that record when the
 * packaging step has already run and fall back to this process otherwise.
 */
export async function readBundledNodeVersion(root) {
  try {
    const raw = await readFile(join(root, "src-tauri", "resources", "server", "node-runtime.json"), "utf8");
    const recorded = JSON.parse(raw)?.node;
    if (typeof recorded === "string" && /^v\d+\.\d+\.\d+/.test(recorded.trim())) return recorded.trim();
  } catch {
    // Not staged yet (or a run that never bundles Node) — fall through.
  }
  return process.version;
}

/** ISO 8601 with an explicit offset, e.g. `2026-11-10T15:35:04+08:00`. */
export function isoTimestampWithOffset(date = new Date()) {
  const pad = (value, width = 2) => String(Math.trunc(Math.abs(value))).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const zone = offsetMinutes === 0
    ? "Z"
    : `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    zone
  );
}

/** ISO 8601 whose zone is required, so a naive local time cannot pass. */
export function isIsoTimestampWithOffset(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

const LEAK_PATTERNS = [
  // Absolute paths of the machine that built it.
  { name: "Windows absolute path", pattern: /[A-Za-z]:[\\/]/ },
  { name: "POSIX home or root path", pattern: /(?:^|[\s"'(])\/(?:Users|home|root|var|tmp|opt|mnt)\// },
  { name: "file URL", pattern: /\bfile:\/\//i },
  { name: "UNC path", pattern: /\\\\[A-Za-z0-9._-]+\\/ },
  // Credentials.
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/ },
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i },
  { name: "URL with credentials", pattern: /https?:\/\/[^\s/@]+:[^\s/@]+@/ },
  // Internal network addresses.
  { name: "private IPv4", pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/ },
  { name: "internal hostname", pattern: /\b[a-z0-9-]+\.(?:internal|local|lan|corp)\b/i },
];

/** Every string inside the fingerprint, keys included. */
function fingerprintStrings(build) {
  const values = [];
  const walk = (value, path) => {
    if (typeof value === "string") values.push([path, value]);
    else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        values.push([`${path}.${key}`, key]);
        walk(entry, `${path}.${key}`);
      }
    }
  };
  walk(build, "build");
  return values;
}

/**
 * AC-6 as an assertion: what would leak, as human-readable strings. Empty
 * means the fingerprint is repository identity and nothing else.
 */
export function findFingerprintLeaks(build) {
  const leaks = [];
  for (const [path, value] of fingerprintStrings(build)) {
    for (const { name, pattern } of LEAK_PATTERNS) {
      if (pattern.test(value)) leaks.push(`${path} looks like ${name}: ${value}`);
    }
  }
  return leaks;
}

export function assertPublicFingerprint(build) {
  if (!build || typeof build !== "object" || Array.isArray(build)) {
    throw new Error("build fingerprint must be an object");
  }
  const keys = Object.keys(build).sort();
  const expected = [...BUILD_FINGERPRINT_KEYS].sort();
  if (keys.join(",") !== expected.join(",")) {
    throw new Error(
      `build fingerprint may only carry ${expected.join(", ")} — got ${keys.join(", ") || "nothing"}`,
    );
  }
  const leaks = findFingerprintLeaks(build);
  if (leaks.length > 0) {
    throw new Error(`build fingerprint would leak local machine details:\n- ${leaks.join("\n- ")}`);
  }
}

/** Shape checks that do not need the repository: types and value formats. */
export function fingerprintProblems(build) {
  const problems = [];
  if (!build || typeof build !== "object" || Array.isArray(build)) {
    return ["build block is missing"];
  }
  const keys = Object.keys(build).sort();
  const expected = [...BUILD_FINGERPRINT_KEYS].sort();
  if (keys.join(",") !== expected.join(",")) {
    problems.push(`build block must carry exactly ${expected.join(", ")}; got ${keys.join(", ") || "nothing"}`);
    return problems;
  }
  if (!/^[0-9a-f]{40}$/.test(build.gitCommit)) problems.push(`gitCommit is not a full sha: ${build.gitCommit}`);
  if (!/^[0-9a-f]{7,40}$/.test(build.gitCommitShort)) problems.push(`gitCommitShort is not a short sha: ${build.gitCommitShort}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(build.gitBranch ?? "")) {
    problems.push(`gitBranch is not a plain branch name: ${build.gitBranch}`);
  }
  if (typeof build.gitDirty !== "boolean") problems.push("gitDirty must be a boolean");
  if (!isIsoTimestampWithOffset(build.builtAt)) problems.push(`builtAt is not ISO 8601 with a timezone: ${build.builtAt}`);
  if (!/^v\d+\.\d+\.\d+/.test(build.node ?? "")) problems.push(`node is not a Node version: ${build.node}`);
  if (build.buildId !== null && !/^\S{1,128}$/.test(build.buildId ?? "")) {
    problems.push(`buildId is neither null nor a plain token: ${build.buildId}`);
  }
  problems.push(...findFingerprintLeaks(build));
  return problems;
}
