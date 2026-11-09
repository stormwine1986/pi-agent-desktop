/**
 * Fork patch for `@earendil-works/pi-schema` — DEFECT-000081.
 *
 * `explain.js`'s `walkUnion` reports only ONE alternative when every branch of
 * an `anyOf`/`oneOf` fails: it picks the branch that declares most of the
 * object's properties, then the one whose first error is deepest. pi-ai feeds
 * every tool call through that explainer, so an MCP tool whose schema says
 * "provide `query` or `branchId`" answered with `- branchId: missing` and hid
 * the `query` path entirely — the caller then concludes the wrong thing.
 *
 * The patch reports every alternative, in branch order (deduplicated). It is
 * the caller-side half of DEFECT-000081 (the server's own text was already
 * correct); see docs/entity/已知问题.md for the sweep, the evidence and the
 * removal condition.
 *
 * Runs from `postinstall`, so `npm ci` / a clean install keeps it. Idempotent;
 * an anchor that no longer matches is an ERROR, never a silent skip — pi-schema
 * is a dependency, not our code, and a silent skip would quietly restore the
 * old text on the next SDK bump.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE = "@earendil-works/pi-schema";

/** Written into explain.js so a second run (and the test) can tell the copy is patched. */
export const PATCH_MARKER = "// pi-web fork patch (DEFECT-000081): a failed union reports every alternative";

/** The block pi-schema 1.5.0 ships. Byte-exact on purpose — a drift must fail loudly. */
const ORIGINAL = `        // An object is blamed on the branch that declares most of its properties (the one it was most likely meant for),
        // then on the branch whose first error is deepest.
        let best;
        for (const s of branches) {
            const errors = [];
            this.walk(s, b, v, path, errors);
            if (errors.length === 0)
                continue;
            const declared = isObject(v) ? this.declaredKeys(s, b, v) : 0;
            const better = best === undefined ||
                declared > best.declared ||
                (declared === best.declared && errors[0].path.length > best.errors[0].path.length);
            if (better)
                best = { errors, declared };
        }
        out.push(...(best?.errors ?? [{ path, keyword, message: "matches no alternative" }]));`;

const PATCHED = `        ${PATCH_MARKER}
        // Every alternative failed, so every alternative is reported: a union is never reduced to the one
        // that happened to fail last (or deepest). One line per distinct error, in branch order.
        const seen = new Set();
        let reported = 0;
        for (const s of branches) {
            const errors = [];
            this.walk(s, b, v, path, errors);
            for (const error of errors) {
                const key = JSON.stringify([error.path, error.message]);
                if (seen.has(key))
                    continue;
                seen.add(key);
                out.push(error);
                reported++;
            }
        }
        if (reported === 0)
            out.push({ path, keyword, message: "matches no alternative" });`;

/**
 * @param {string} source the whole `explain.js`
 * @returns {{ source: string, state: "patched" | "applied" }} "patched" when the marker is already there
 * @throws when neither the marker nor the anchor is present (the package drifted)
 */
export function patchExplainSource(source) {
  if (source.includes(PATCH_MARKER)) return { source, state: "patched" };
  if (!source.includes(ORIGINAL)) {
    throw new Error(
      `${PACKAGE}: walkUnion's "best branch" block is gone, so this patch no longer applies. ` +
        `Check whether upstream now reports every alternative (then delete scripts/patch-pi-schema-union.mjs ` +
        `and the postinstall step), or update the anchor in it. docs/entity/已知问题.md has the background.`,
    );
  }
  return { source: source.replace(ORIGINAL, PATCHED), state: "applied" };
}

/** Absolute path of the installed `dist/explain.js`, wherever npm put the package. */
export function explainPath() {
  const entry = import.meta.resolve(PACKAGE);
  return join(dirname(fileURLToPath(entry)), "explain.js");
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const path = explainPath();
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    // A production install without the fork's dev dependencies still has pi-ai,
    // which needs pi-schema; treat a missing file as a real failure.
    throw new Error(`${PACKAGE}: cannot read ${path} (${error.message})`);
  }

  const { source: next, state } = patchExplainSource(source);

  if (checkOnly) {
    if (state === "patched") {
      console.log(`[patch-pi-schema] ok: ${path} carries the DEFECT-000081 patch`);
      return;
    }
    console.error(`[patch-pi-schema] MISSING: ${path} is unpatched (run npm run postinstall)`);
    process.exitCode = 1;
    return;
  }

  if (state === "patched") {
    console.log(`[patch-pi-schema] already patched: ${path}`);
    return;
  }

  writeFileSync(path, next);
  console.log(`[patch-pi-schema] patched ${PACKAGE} walkUnion (DEFECT-000081): ${path}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
