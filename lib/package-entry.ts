import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Absolute path of one package's root `import` entry, resolved from `cwd`.
 *
 * Split out of `lib/pi-sdk-internals.ts` so callers that only need a file path
 * do not pull that module in: it belongs to the MCP-internals loader, and
 * `lib/models-worker.ts` — reached from `GET /api/models`, a request that lands
 * while the user is already interacting (DEFECT-000101) — must not import
 * anything that loads the SDK, not even lazily.
 *
 * The package exports `types`/`import` only, so `require.resolve()` cannot
 * produce this path (DEFECT-000092); the manifest is read instead, and the
 * `import` condition is what the runtime would pick.
 */
export function resolvePackageImportEntry(packageName: string, cwd = process.cwd()): string {
  return resolvePackageImportEntryFrom(packageName, pathToFileURL(join(cwd, "package.json")).href, cwd);
}

/** The same lookup, relative to a file that imports the package (a nested dependency). */
export function resolvePackageImportEntryFrom(
  packageName: string,
  importerHref: string,
  context = importerHref,
): string {
  const manifestPath = findPackageJSON(packageName, importerHref);
  if (!manifestPath) throw new Error(`cannot resolve ${packageName} from ${context}`);
  const entry = packageImportEntry(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!entry) throw new Error(`${manifestPath} declares no import entry`);
  return realpathSync(join(manifestPath, "..", entry));
}

function packageImportEntry(manifest: unknown): string | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const record = manifest as { exports?: unknown; main?: unknown };
  const { exports } = record;
  if (exports === undefined) return typeof record.main === "string" ? record.main : "index.js";
  return conditionalTarget(isRecord(exports) && "." in exports ? exports["."] : exports)
    ?? undefined;
}

function conditionalTarget(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (!isRecord(target)) return undefined;
  for (const key of ["import", "module", "default", "node"]) {
    const value = target[key];
    const resolved = conditionalTarget(value);
    if (resolved) return resolved;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
