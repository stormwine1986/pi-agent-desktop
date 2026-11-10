import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { APP_VERSION } from "@/lib/branding";
import type { AppBuildFingerprint, AppInfo } from "@/lib/app-build-info";

const MANIFEST_NAME = "component-versions.json";

/**
 * Locate the packaged manifest.
 *
 * - Packaged: the Rust shell starts the server with the server directory as its
 *   working directory (`resources/server`), and the manifest sits beside it
 *   (`resources/component-versions.json`) — the same file the shell compares
 *   against in `stale_running_build()`.
 * - `npm run dev` / `npm start` from a checkout: the repository copy.
 */
export function locateComponentManifest(cwd = process.cwd()) {
  const candidates = [
    resolve(cwd, "..", MANIFEST_NAME),
    resolve(cwd, "src-tauri", "resources", MANIFEST_NAME),
    resolve(cwd, MANIFEST_NAME),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Accepts only the shape this module promises, so a stray field cannot leak out. */
export function normalizeBuild(raw: unknown): AppBuildFingerprint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const string = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  const buildId = typeof value.buildId === "string" && value.buildId.trim().length > 0
    ? value.buildId.trim()
    : null;
  const gitCommit = string("gitCommit");
  if (!gitCommit) return null;
  return {
    gitCommit,
    gitCommitShort: string("gitCommitShort") || gitCommit.slice(0, 7),
    gitBranch: string("gitBranch"),
    gitDirty: value.gitDirty === true,
    builtAt: string("builtAt"),
    node: string("node"),
    buildId,
  };
}

/**
 * Reads the manifest fresh on every call: an overwrite install replaces it
 * while the app runs, and a cached answer would be exactly the stale build
 * identity this feature exists to expose.
 */
export async function readAppInfo(options: { manifestPath?: string | null } = {}): Promise<AppInfo> {
  const manifestPath = options.manifestPath === undefined ? locateComponentManifest() : options.manifestPath;
  if (!manifestPath) return { appVersion: APP_VERSION, build: null };
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const appVersion = typeof manifest?.appVersion === "string" && manifest.appVersion
      ? manifest.appVersion
      : APP_VERSION;
    return { appVersion, build: normalizeBuild(manifest?.build) };
  } catch {
    return { appVersion: APP_VERSION, build: null };
  }
}
