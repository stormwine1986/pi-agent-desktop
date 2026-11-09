/**
 * DEFECT-000081: the caller-side argument check must not reduce an `anyOf` to a
 * single alternative. `scripts/patch-pi-schema-union.mjs` patches
 * `@earendil-works/pi-schema`'s `walkUnion` from `postinstall`; this test is the
 * net that notices when the install loses that patch (a fresh `npm ci` without
 * postinstall, an SDK bump, a Windows the scripts were never run on).
 *
 * The schemas below mirror what entity-base publishes for `list` / `link`
 * (`src/domain/tools/dynamic-tool-registry.ts`): `required: [workspaceId]` plus
 * `anyOf: [{required:[query]}, {required:[branchId]}]`, and the same shape for
 * `targetId` / `targetIds`. The full sweep over every MCP tool is recorded in
 * docs/entity/已知问题.md.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

import { PATCH_MARKER, explainPath, patchExplainSource } from "./patch-pi-schema-union.mjs";

/** pi-ai's own options (dist/utils/validation.js), so this is the message a tool call shows. */
const OPTIONS = { formats, coerce: true, unresolvedRefs: "reject" };

function format(errors) {
  return errors
    .map((error) => `  - ${error.path === "" ? "root" : error.path.slice(1).split("/").join(".")}: ${error.message}`)
    .join("\n");
}

function parse(schema, args) {
  const result = compile(structuredClone(schema), OPTIONS).parse(structuredClone(args));
  return result.ok ? { ok: true } : { ok: false, text: format(result.errors) };
}

const listSchema = {
  type: "object",
  properties: {
    workspaceId: { type: "string" },
    query: { type: "string" },
    branchId: { type: "string" },
    limit: { type: "integer" },
  },
  required: ["workspaceId"],
  anyOf: [{ required: ["query"] }, { required: ["branchId"] }],
};

const linkSchema = {
  type: "object",
  properties: {
    sourceId: { type: "string" },
    linkType: { type: "string" },
    targetId: { type: "string" },
    targetIds: { type: "array", items: { type: "string" } },
  },
  required: ["sourceId", "linkType"],
  anyOf: [{ required: ["targetId"] }, { required: ["targetIds"] }],
};

test("the installed pi-schema carries the patch", () => {
  const source = readFileSync(explainPath(), "utf8");
  assert.equal(
    source.includes(PATCH_MARKER),
    true,
    "unpatched pi-schema: run `node scripts/patch-pi-schema-union.mjs` (postinstall does)",
  );
  assert.deepEqual(patchExplainSource(source).state, "patched");
});

test("the patch applies once and refuses to drift silently", () => {
  const synthetic = `        // An object is blamed on the branch that declares most of its properties (the one it was most likely meant for),
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
        out.push(...(best?.errors ?? [{ path, keyword, message: "matches no alternative" }]));
    }`;

  const once = patchExplainSource(synthetic);
  assert.equal(once.state, "applied");
  assert.equal(once.source.includes(PATCH_MARKER), true);
  assert.equal(once.source.includes("let best;"), false);
  assert.deepEqual(patchExplainSource(once.source), { source: once.source, state: "patched" });

  // A package bump that reshapes walkUnion must break the install, not the text.
  assert.throws(() => patchExplainSource("export function walkUnion() {}"), /no longer applies/);
});

test("list(namespace, limit) names both paths: query and branchId", () => {
  const result = parse(listSchema, { workspaceId: "ws_entity_base", limit: 5 });
  assert.equal(result.ok, false);
  assert.match(result.text, /- query: /);
  assert.match(result.text, /- branchId: /);
});

test("link(sourceId, linkType) names both paths: targetId and targetIds", () => {
  const result = parse(linkSchema, { sourceId: "sr_1", linkType: "implements" });
  assert.equal(result.ok, false);
  assert.match(result.text, /- targetId: /);
  assert.match(result.text, /- targetIds: /);
});

test("legal arguments still pass (no new rejections)", () => {
  for (const args of [
    { workspaceId: "ws_entity_base", query: "", limit: 5 },
    { workspaceId: "ws_entity_base", query: "type = 'TASK'", branchId: "br_main" },
    { workspaceId: "ws_entity_base", branchId: "br_main" },
  ]) {
    assert.deepEqual(parse(listSchema, args), { ok: true }, `list ${JSON.stringify(args)}`);
  }
  for (const args of [
    { sourceId: "sr_1", linkType: "implements", targetId: "ssr_1" },
    { sourceId: "sr_1", linkType: "implements", targetIds: ["ssr_1", "ssr_2"] },
  ]) {
    assert.deepEqual(parse(linkSchema, args), { ok: true }, `link ${JSON.stringify(args)}`);
  }
});

test("a tagged union keeps reporting only its tag", () => {
  const tagged = {
    type: "object",
    anyOf: [
      { properties: { kind: { const: "a" }, a: { type: "number" } }, required: ["kind", "a"] },
      { properties: { kind: { const: "b" }, b: { type: "string" } }, required: ["kind", "b"] },
    ],
  };
  const result = parse(tagged, { kind: "c" });
  assert.equal(result.ok, false);
  assert.equal(result.text.trim(), '- kind: expected one of ["a","b"]');
});
