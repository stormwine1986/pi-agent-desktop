import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { entityRefId, formatEntityContextBlock } = await jiti.import("./entity-context.ts");

const ref = {
  server: "entity-demo-system-evan",
  workspace: "ws_entity_base",
  key: "SSR-000083",
  name: "表单内完成全流程，与会话同源（FM-SUBMIT）",
  state: "DEFINED",
};

test("the block carries the key, the state and the space", () => {
  const block = formatEntityContextBlock([ref]);
  assert.match(block, /SSR-000083/);
  assert.match(block, /《表单内完成全流程，与会话同源（FM-SUBMIT）》/);
  assert.match(block, /DEFINED/);
  assert.match(block, /ws_entity_base/);
  assert.match(block, /以实体当前值为准/);
});

test("the block names no channel — no server, no tool, no URL", () => {
  // A session may reach the same entity through a differently named server (pi
  // writes a configured `-` as `_`, a view may carry an alias, a project may
  // point at another stack). A literal tool name in the transcript then tells
  // the reader to call something that does not exist here.
  const block = formatEntityContextBlock([ref, { ...ref, server: "entity-base", key: "SSR-000090" }]);
  assert.doesNotMatch(block, /mcp__/);
  assert.doesNotMatch(block, /entity-demo-system-evan/);
  assert.doesNotMatch(block, /entity-base/);
  assert.doesNotMatch(block, /https?:/);
  assert.doesNotMatch(block, /\bget\b\s*\{/);
});

test("the instruction sends the reader to this session's own tools", () => {
  const block = formatEntityContextBlock([ref]);
  assert.match(block, /本会话里可用的实体工具/);
  assert.match(block, /不要以本段文字或历史消息里的旧值为据/);
  // A single-entity read rejects extra arguments, so the example must not invite one.
  assert.match(block, /只传 id/);
  assert.match(block, /不要附带 workspaceId/);
  // Without an entity tool the answer must stop, not invent values.
  assert.match(block, /不要凭印象作答/);
});

test("nothing carried means nothing appended", () => {
  assert.equal(formatEntityContextBlock([]), "");
});

test("an unnamed, stateless entity still reads as a pointer", () => {
  const block = formatEntityContextBlock([{ server: "s", workspace: "ws_x", key: "TASK-000001" }]);
  assert.match(block, /· TASK-000001（空间 ws_x）/);
  assert.doesNotMatch(block, /《/);
});

test("the same key on two servers stays two references", () => {
  assert.notEqual(entityRefId(ref), entityRefId({ ...ref, server: "entity-base" }));
  assert.equal(entityRefId(ref), entityRefId({ ...ref, name: undefined }));
});
