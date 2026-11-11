import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep, basename } from "node:path";

/**
 * webpack's placeholder for a dynamic import it could not resolve.
 *
 * `await import(<specifier>)` whose request the graph judges unresolvable is
 * compiled into a function that rejects with `Cannot find module '<specifier>'`
 * whatever is installed. It looks like a working build and fails only when the
 * code path runs — which is how DEFECT-000092 turned MCP off in every 0.8.2
 * package while every other feature stayed healthy.
 *
 * The marker below is the stub's own code, not the message Next writes for a
 * missing page: `Cannot find module '"+e+"'` (concatenation, no "for page").
 */
export const UNRESOLVED_DYNAMIC_IMPORT = `Cannot find module '"`;

/**
 * The `server` directories of every Next build output at `root`: the roots this
 * script is given are a payload root (holding `.next`, `.next-desktop`, …) or a
 * dist dir itself.
 */
async function serverDirs(root) {
  const candidates = [];
  if (basename(root).startsWith(".next")) candidates.push(join(root, "server"));
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(".next")) candidates.push(join(root, entry.name, "server"));
  }
  return candidates;
}

async function* jsFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(path);
    else if (entry.isFile() && entry.name.endsWith(".js")) yield path;
  }
}

/**
 * Every server-bundle file under the given build output roots that still carries
 * the placeholder. Server bundles only: a browser build resolves ESM normally,
 * and the stub has no meaning there.
 */
export async function findUnresolvedDynamicImports(roots) {
  const found = [];
  for (const root of roots) {
    for (const serverDir of await serverDirs(root)) {
      for await (const file of jsFiles(serverDir)) {
        const source = await readFile(file, "utf8");
        const occurrences = source.split(UNRESOLVED_DYNAMIC_IMPORT).length - 1;
        if (occurrences > 0) found.push({ file, occurrences });
      }
    }
  }
  return found;
}

/**
 * Fails the build while the cause is still one package's `exports` conditions,
 * not after a user finds a feature switched off. Called by
 * `scripts/prepare-desktop.mjs` straight after the desktop build, and runnable
 * by hand against any output tree.
 */
export async function assertNoUnresolvedDynamicImports(roots) {
  const found = await findUnresolvedDynamicImports(roots);
  if (found.length === 0) return;
  const detail = found.map(({ file, occurrences }) => `  ${file} (${occurrences})`).join("\n");
  throw new Error(
    "Built server bundles contain webpack's unresolved dynamic import placeholder " +
      `(\`${UNRESOLVED_DYNAMIC_IMPORT}\`), which throws "Cannot find module" at run time:\n${detail}\n` +
      "A bare `import()` of a package whose `exports` has no `require` condition is compiled into it " +
      "(DEFECT-000092). Load the module by file URL with the bundler's ignore markers instead.",
  );
}

const invokedDirectly = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error("usage: node scripts/unresolved-imports.mjs <build-output-dir>...");
    process.exit(2);
  }
  const found = await findUnresolvedDynamicImports(roots);
  for (const { file, occurrences } of found) console.error(`${separator(file, roots)}\t${occurrences}`);
  console.log(found.length === 0 ? "no unresolved dynamic import placeholders" : `${found.length} file(s) affected`);
  process.exit(found.length === 0 ? 0 : 1);
}

function separator(file, roots) {
  const root = roots.find((candidate) => file.startsWith(candidate)) ?? roots[0] ?? "";
  return relative(root, file).split(sep).join("/");
}
