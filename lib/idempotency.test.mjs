import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { acceptedKey, newKey, submissionKey } = await jiti.import("./idempotency.ts");

test("the same submission keeps its key, so a retry replays instead of repeating", () => {
  let made = 0;
  const make = () => `k-${(made += 1)}`;

  const first = submissionKey(null, "create:TASK:{}", make);
  const retry = submissionKey(first, "create:TASK:{}", make);

  assert.equal(retry.key, first.key);
  assert.equal(made, 1, "a retry must not mint a second key");
});

test("changed content is a new attempt and gets a new key", () => {
  let made = 0;
  const make = () => `k-${(made += 1)}`;

  const first = submissionKey(null, "update:3:{}", make);
  const afterEdit = submissionKey(first, "update:3:{\"name\":\"x\"}", make);

  assert.notEqual(afterEdit.key, first.key);
  assert.equal(made, 2);
});

test("a reloaded revision is a new attempt too", () => {
  const make = () => `k-${Math.random()}`;
  const before = submissionKey(null, "update:3:{\"name\":\"x\"}", make);
  const afterReload = submissionKey(before, "update:4:{\"name\":\"x\"}", make);
  assert.notEqual(afterReload.key, before.key);
});

test("a well-formed key from the caller is used as given", () => {
  assert.equal(acceptedKey("panel-6f1c2a8e-1f0b-4a1d-9d2e-8f7a6b5c4d3e", () => "generated"), "panel-6f1c2a8e-1f0b-4a1d-9d2e-8f7a6b5c4d3e");
});

test("a missing or malformed key falls back instead of failing the write", () => {
  const make = () => "generated";
  // Too short, wrong characters, and not a string at all: none of these should
  // let a save die on a clipboard pasted into a debugging tool.
  assert.equal(acceptedKey(undefined, make), "generated");
  assert.equal(acceptedKey("short", make), "generated");
  assert.equal(acceptedKey("has space and more", make), "generated");
  assert.equal(acceptedKey(42, make), "generated");
});

test("generated keys are unique and carry their prefix", () => {
  const first = newKey("panel");
  const second = newKey("panel");
  assert.match(first, /^panel-/);
  assert.notEqual(first, second);
});
