import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  // A background subagent completion starts a new displayed turn, same as a
  // user message or a compaction / branch summary. Other custom messages stay inside the turn.
  return message.role === "user"
    || (message.role === "custom" && (
      message.customType === "compaction"
      || message.customType === "branch_summary"
      || message.customType === "pi-web:subagent-notification"
    ));
}

/**
 * A block the renderer can actually read: anything else (a stale `undefined`
 * left behind by a streaming merge, `null`, a bare string) is dropped instead
 * of crashing the whole page on `block.type` — DEFECT-000119.
 */
export function isAssistantContentBlock(value: unknown): value is AssistantContentBlock {
  return typeof value === "object" && value !== null;
}

/** Content arrays arrive from live state as well as from disk, so narrow them here. */
function assistantContentBlocks(content: unknown): AssistantContentBlock[] {
  return Array.isArray(content) ? content.filter(isAssistantContentBlock) : [];
}

export function isEmptyThinkingBlock(
  block: AssistantContentBlock | null | undefined,
  options: DisplayOptions = {},
): block is ThinkingContent {
  // Not a block at all: nothing to hide, and nothing may be read off it.
  if (!isAssistantContentBlock(block)) return false;
  if (block.type !== "thinking" || block.deferred || options.isStreaming) return false;
  const thinking = typeof block.thinking === "string" ? block.thinking : "";
  return thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return assistantContentBlocks(message.content).filter((block) => !isEmptyThinkingBlock(block, options));
}

export interface AssistantBlockItem {
  block: AssistantContentBlock;
  originalIndex: number;
}

/**
 * What the assistant view actually renders, in one place: non-blocks dropped,
 * empty streaming thinking hidden, original indices kept for keys/durations.
 */
export function getAssistantBlockItems(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantBlockItem[] {
  const items: AssistantBlockItem[] = [];
  const content: unknown[] = Array.isArray(message.content) ? message.content : [];
  content.forEach((block, originalIndex) => {
    if (!isAssistantContentBlock(block) || isEmptyThinkingBlock(block, options)) return;
    items.push({ block, originalIndex });
  });
  return items;
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/**
 * A turn that ended on `stopReason: "length"` spent its whole output budget
 * (often on reasoning alone) and produced no final answer; without a notice it
 * looks like a hung session. The copy lives in i18n (`chat.truncatedByOutputLimit`).
 */
export function isAssistantTruncated(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return !options.isStreaming && message.stopReason === "length";
}

/** Text, an image, or a tool call is an answer. Thinking alone is not. */
export function hasAssistantAnswer(message: AssistantMessage): boolean {
  return assistantContentBlocks(message.content).some((block) => {
    if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
    return block.type === "image" || block.type === "toolCall";
  });
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter(isAssistantContentBlock).filter((block): block is ToolCallContent => block.type === "toolCall").length;
}
