import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("bounds thinking previews to the first nonblank line without splitting Unicode characters", async () => {
  const { getThinkingPreview } = await loadSubject();
  assert.equal(getThinkingPreview(" \r\n **First line** \r\nSecond line"), "**First line**");
  assert.equal(getThinkingPreview("First\rSecond"), "First");
  assert.equal(getThinkingPreview(" \n\t"), "");
  assert.equal(getThinkingPreview("\u{1F4A1}".repeat(300)), "\u{1F4A1}".repeat(240));
});

test("splits trailing final answer blocks from process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "image"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
});

test("keeps pre-tool text in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, "Final answer");
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["text", "toolCall"]);
});

test("does not expose text before a trailing tool call as final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks, []);
});

test("keeps empty thinking while streaming", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: true });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("returns completed provider errors even when the message has no content", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: "OpenAI API error (403): request forbidden",
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "OpenAI API error (403): request forbidden",
  );
  assert.equal(getAssistantErrorMessage(message, { isStreaming: true }), null);
});

test("falls back when a provider error has no message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "error" }),
    "Unknown provider error",
  );
  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "stop" }),
    null,
  );
});

test("treats compaction summaries as turn anchors", async () => {
  const { isMessageGroupAnchor } = await loadSubject();

  assert.equal(isMessageGroupAnchor({ role: "user", content: "prompt" }), true);
  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "compaction",
    content: "summary",
    display: true,
  }), true);
  assert.equal(isMessageGroupAnchor(assistant([])), false);
});

test("treats a background subagent completion as a turn anchor", async () => {
  const { isMessageGroupAnchor } = await loadSubject();

  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "pi-web:subagent-notification",
    content: "Subagent child completed.\n\nParser found",
    display: true,
  }), true);
  assert.equal(isMessageGroupAnchor({
    role: "custom",
    customType: "extension_debug",
    content: "hidden extension payload",
    display: false,
  }), false);
});

test("isAssistantTruncated is true only for a finished stopReason length", async () => {
  const { isAssistantTruncated } = await loadSubject();

  const truncated = {
    ...assistant([{ type: "thinking", thinking: " lengthy reasoning " }]),
    stopReason: "length",
  };
  assert.equal(isAssistantTruncated(truncated), true);
  // Still streaming: the final stopReason is not known yet.
  assert.equal(isAssistantTruncated(truncated, { isStreaming: true }), false);
  assert.equal(isAssistantTruncated({ ...assistant([]), stopReason: "stop" }), false);
  assert.equal(isAssistantTruncated({ ...assistant([]), stopReason: "error", errorMessage: "oops" }), false);
  assert.equal(isAssistantTruncated({ ...assistant([]) }), false);
});

// DEFECT-000119: live state briefly held a non-block in the content array and
// the render path read `.type` off it, taking the whole page down.
test("drops non-object content blocks instead of reading .type off them", async () => {
  const { getDisplayableAssistantBlocks, isAssistantContentBlock } = await loadSubject();
  const message = assistant([
    undefined,
    null,
    "a bare string",
    42,
    { type: "text", text: "kept" },
    { type: "thinking", thinking: "" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );
  assert.equal(isAssistantContentBlock(undefined), false);
  assert.equal(isAssistantContentBlock(null), false);
  assert.equal(isAssistantContentBlock("text"), false);
  assert.equal(isAssistantContentBlock({ type: "text", text: "" }), true);
});

test("treats a non-array content payload as empty instead of throwing", async () => {
  const { getDisplayableAssistantBlocks, hasAssistantAnswer } = await loadSubject();
  const message = { ...assistant([]), content: "not an array" };

  assert.deepEqual(getDisplayableAssistantBlocks(message), []);
  assert.equal(hasAssistantAnswer(message), false);
});

test("isEmptyThinkingBlock never hides a block it cannot read", async () => {
  const { isEmptyThinkingBlock } = await loadSubject();

  assert.equal(isEmptyThinkingBlock(undefined), false);
  assert.equal(isEmptyThinkingBlock(null), false);
  assert.equal(isEmptyThinkingBlock({}), false);
  assert.equal(isEmptyThinkingBlock({ type: "thinking" }), true);
  assert.equal(isEmptyThinkingBlock({ type: "thinking", thinking: "" }), true);
  assert.equal(isEmptyThinkingBlock({ type: "thinking", thinking: " " }), true);
  assert.equal(isEmptyThinkingBlock({ type: "thinking", thinking: "reasoning" }), false);
  assert.equal(isEmptyThinkingBlock({ type: "thinking", thinking: "" }, { isStreaming: true }), false);
  assert.equal(isEmptyThinkingBlock({ type: "text", text: "" }), false);
});

test("getAssistantBlockItems skips bad blocks and keeps original indices", async () => {
  const { getAssistantBlockItems } = await loadSubject();
  const message = assistant([
    undefined,
    { type: "text", text: "first" },
    null,
    { type: "thinking", thinking: "" },
    { type: "text", text: "second" },
  ]);

  assert.deepEqual(getAssistantBlockItems(message, { isStreaming: false }), [
    { block: { type: "text", text: "first" }, originalIndex: 1 },
    { block: { type: "text", text: "second" }, originalIndex: 4 },
  ]);
});

test("answer and tool-call counting tolerate non-object blocks", async () => {
  const { countToolCallBlocks, getDisplayableAssistantBlocks, hasAssistantAnswer } = await loadSubject();
  const message = assistant([
    undefined,
    "junk",
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  assert.equal(hasAssistantAnswer(message), true);
  assert.equal(hasAssistantAnswer(assistant([undefined, "junk"])), false);
  assert.equal(countToolCallBlocks(getDisplayableAssistantBlocks(message)), 1);
  assert.equal(countToolCallBlocks([undefined, null, "junk"]), 0);
});
