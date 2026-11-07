import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { MAX_LINK_KEYS, evaluateLinkKeys, parseLinkKeys } = await jiti.import("./entity-links.ts");

test("keys are split on the separators people actually paste", () => {
  const parsed = parseLinkKeys("MR-000250  MR-000244,MR-000112，MR-0009;\nMR-000201");
  assert.deepEqual(parsed.keys, ["MR-000250", "MR-000244", "MR-000112", "MR-0009", "MR-000201"]);
  assert.equal(parsed.total, 5);
  assert.equal(parsed.overflow, 0);
});

test("the same key typed twice is one key, whatever its case", () => {
  const parsed = parseLinkKeys("MR-000250 mr-000250 MR-000244");
  assert.deepEqual(parsed.keys, ["MR-000250", "MR-000244"]);
  assert.equal(parsed.total, 2);
});

test("too many keys are counted, never silently dropped", () => {
  const text = Array.from({ length: MAX_LINK_KEYS + 3 }, (_, index) => `MR-${String(index).padStart(6, "0")}`).join(" ");
  const parsed = parseLinkKeys(text);
  assert.equal(parsed.keys.length, MAX_LINK_KEYS);
  assert.equal(parsed.total, MAX_LINK_KEYS + 3);
  assert.equal(parsed.overflow, 3);
});

const base = {
  sourceKey: "OR-000019",
  targetTypes: ["MR"],
  allowedTargetStates: ["CREATED", "DEFINED"],
  found: [
    { key: "MR-000250", type: "MR", name: "价格带分层", state: "DEFINED" },
    { key: "MR-000112", type: "MR", name: "旧口径", state: "INVALID" },
    { key: "PCA-000242", type: "PCA", name: "配置分析", state: "IN_ANALYSIS" },
  ],
  linkedKeys: ["MR-000250"],
};

test("a key that passes every base check is accepted, with the entity's own spelling", () => {
  const [item] = evaluateLinkKeys({ ...base, keys: ["mr-000244"], found: [...base.found, { key: "MR-000244", type: "MR", name: "上线周期", state: "CREATED" }] });
  assert.equal(item.ok, true);
  assert.equal(item.resolvedKey, "MR-000244");
  assert.equal(item.name, "上线周期");
});

test("an entity cannot be linked to itself", () => {
  const [item] = evaluateLinkKeys({ ...base, keys: ["OR-000019"] });
  assert.equal(item.ok, false);
  assert.equal(item.reason, "self");
});

test("a key with characters that would have to be escaped is refused up front", () => {
  const [item] = evaluateLinkKeys({ ...base, keys: ["MR'000250"] });
  assert.equal(item.ok, false);
  assert.equal(item.reason, "invalid");
});

test("a key the space does not hold is missing, and says so about case", () => {
  const [item] = evaluateLinkKeys({ ...base, keys: ["MR-999999"] });
  assert.equal(item.reason, "not-found");
  assert.match(item.detail, /大小写/);
});

test("a type the relation does not declare is refused before the write", () => {
  const [item] = evaluateLinkKeys({ ...base, keys: ["PCA-000242"] });
  assert.equal(item.reason, "type");
  assert.match(item.detail, /MR/);
});

test("a target in a state the relation forbids is refused, naming the state", () => {
  const [item] = evaluateLinkKeys({ ...base, keys: ["MR-000112"] });
  assert.equal(item.reason, "state");
  assert.match(item.detail, /INVALID/);
});

test("a link that is already active is not offered twice", () => {
  const [item] = evaluateLinkKeys({ ...base, keys: ["MR-000250"] });
  assert.equal(item.reason, "linked");
});

test("verdicts come back in the order the reader typed, one per key", () => {
  const items = evaluateLinkKeys({ ...base, keys: ["MR-999999", "MR-000250", "MR-000112"] });
  assert.deepEqual(items.map((item) => item.key), ["MR-999999", "MR-000250", "MR-000112"]);
  assert.deepEqual(items.map((item) => item.reason), ["not-found", "linked", "state"]);
});

test("no declared target type means the type check does not fire", () => {
  // With neither a target-type list nor a state list the relation constrains
  // nothing, so a readable entity of any type passes.
  const [item] = evaluateLinkKeys({ ...base, keys: ["PCA-000242"], targetTypes: [], allowedTargetStates: [] });
  assert.equal(item.ok, true);
});

test("no allowed target states means every state is accepted", () => {
  const [item] = evaluateLinkKeys({ ...base, keys: ["MR-000112"], linkedKeys: [], allowedTargetStates: [] });
  assert.equal(item.ok, true);
});
