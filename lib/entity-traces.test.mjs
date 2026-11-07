import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { normalizeTraces } = await jiti.import("./entity-traces.ts");

const upstreamLink = {
  linkType: "satisfies",
  inverseLinkType: "is_satisfied_by",
  direction: "upstream",
  isActive: true,
  // The base embeds only the far end: no sourceEntity when the source is self.
  targetEntity: { key: "MR-000035", type: "MR", name: "缺失描述的需求", state: "CREATED" },
};

const downstreamLink = {
  linkType: "support",
  inverseLinkType: "is_supported_by",
  direction: "downstream",
  isActive: true,
  sourceEntity: { key: "EVIDENCE-000063", type: "Evidence", name: "探针", state: "DEFINED" },
};

test("an upstream link keeps its target even though no source is embedded", () => {
  const { upstream, downstream } = normalizeTraces([upstreamLink], "OR-000091");
  assert.deepEqual(upstream.map((row) => row.key), ["MR-000035"]);
  assert.equal(upstream[0].linkType, "satisfies");
  assert.equal(downstream.length, 0);
});

test("a downstream link keeps its source and its inverse name", () => {
  const { upstream, downstream } = normalizeTraces([downstreamLink], "OR-000091");
  assert.deepEqual(downstream.map((row) => row.key), ["EVIDENCE-000063"]);
  // Reading downstream with the owner's name would say "support" (the evidence
  // supports this OR), which is backwards from this entity's side.
  assert.equal(downstream[0].inverseLinkType, "is_supported_by");
  assert.equal(upstream.length, 0);
});

test("both ends embedded: the far one is kept", () => {
  const both = {
    ...upstreamLink,
    sourceEntity: { key: "OR-000091", type: "OR", name: "self", state: "DRAFT" },
  };
  const { upstream } = normalizeTraces([both], "OR-000091");
  assert.deepEqual(upstream.map((row) => row.key), ["MR-000035"]);
});

test("a missing direction is taken from which end the base kept", () => {
  const { upstream, downstream } = normalizeTraces(
    [{ ...upstreamLink, direction: undefined }, { ...downstreamLink, direction: undefined }],
    "OR-000091",
  );
  assert.deepEqual(upstream.map((row) => row.key), ["MR-000035"]);
  assert.deepEqual(downstream.map((row) => row.key), ["EVIDENCE-000063"]);
});

test("deleted links and self-links never reach the panel", () => {
  const deleted = { ...upstreamLink, isActive: false };
  const self = {
    ...upstreamLink,
    sourceEntity: { key: "OR-000091" },
    targetEntity: { key: "OR-000091", type: "OR", name: "self", state: "DRAFT" },
  };
  const { upstream } = normalizeTraces([deleted, self], "OR-000091");
  assert.deepEqual(upstream, []);
});

test("a link with neither end embedded is skipped instead of crashing", () => {
  assert.deepEqual(normalizeTraces([{ ...upstreamLink, targetEntity: undefined }], "OR-000091"), {
    upstream: [],
    downstream: [],
  });
});
