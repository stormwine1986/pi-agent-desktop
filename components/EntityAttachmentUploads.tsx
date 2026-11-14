"use client";

import {
  attachmentUploadRules,
  attachmentUploadStepLabel,
  type AttachmentUploadEntry,
  type AttachmentUploadStep,
} from "@/lib/entity-attachments";

import { accent, buttonStyle, danger, line, muted, surface } from "./entity-field";

/**
 * The upload entries of an attachment panel, one per declared category
 * (`SSR-000126` AC-2 / AC-3 / AC-7).
 *
 * Three states, decided by `attachmentUploadEntries` and only stated here:
 * - `role` — no entry at all. A greyed-out button would claim the action exists
 *   for this reader, and it does not.
 * - `state` — the entry is visible but disabled with 「当前状态只读」, because the
 *   model froze this category in this state and the reader should learn that
 *   before picking a file, not after uploading one.
 * - `multiple` — disabled with the reason: this category takes one active
 *   attachment and one is already bound. Nothing would be sent.
 *
 * The file picker is a `<label>` wrapping a hidden `<input type="file">`: one
 * native dialog per entry, no drag-and-drop and no multi-select (both out of
 * scope for this round), and `accept` carries the category's own `contentTypes`
 * so the dialog filters before the pre-check has to.
 */
export function EntityAttachmentUploads({ entries, busy, disabled, onSelect }: {
  entries: AttachmentUploadEntry[];
  /** The upload in flight, if any: one at a time, and it says which step it is on. */
  busy: { category: string; step: AttachmentUploadStep } | null;
  /** Another attachment operation (a download) is running. */
  disabled: boolean;
  onSelect: (entry: AttachmentUploadEntry, file: File) => void;
}) {
  // A reader with no write role is offered nothing here (`SSR-000126` AC-3):
  // no row, no picker, no disabled button that implies the action exists.
  const offered = entries.filter((entry) => entry.blocked !== "role");
  if (offered.length === 0) return null;

  return (
    <div
      style={{
        flexShrink: 0,
        padding: "8px 10px 6px",
        borderBottom: `1px solid ${line}`,
        background: surface,
      }}
    >
      <div style={{ fontSize: "var(--fs-micro)", color: muted, marginBottom: 4 }}>
        按类型声明的分类上传：先传内容、再绑定，字节只走这个 server 条目自己的凭证
      </div>
      {offered.map((entry) => {
        const category = entry.category;
        const busyHere = busy?.category === category.key;
        const unavailable = disabled || busy !== null;
        const reason = entry.blocked === "state"
          ? "当前状态只读"
          : entry.blocked === "multiple"
            ? `只允许一个活跃附件，已有 ${entry.activeCount} 个`
            : null;
        return (
          <div
            key={category.key}
            data-attachment-upload={category.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "3px 0",
              fontSize: "var(--fs-caption)",
            }}
          >
            <span style={{ flexShrink: 0 }} title={category.key}>
              {category.label}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--fs-micro)",
                color: muted,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={`${category.key}：${attachmentUploadRules(category)}`}
            >
              {attachmentUploadRules(category)}
              {category.multiple === false ? "，只能一个" : ""}
            </span>
            {reason ? (
              <span
                title={entry.blocked === "state"
                  ? `分类 ${category.key} 的写策略在当前状态被冻结`
                  : `分类 ${category.key} 声明 multiple: false`}
                style={{
                  flexShrink: 0,
                  color: entry.blocked === "state" ? danger : muted,
                  border: `1px solid ${line}`,
                  borderRadius: 6,
                  padding: "2px 8px",
                  fontSize: "var(--fs-micro)",
                  whiteSpace: "nowrap",
                }}
              >
                {reason}
              </span>
            ) : (
              <label
                style={{
                  ...buttonStyle,
                  flexShrink: 0,
                  display: "inline-block",
                  borderColor: accent,
                  color: accent,
                  padding: "2px 9px",
                  fontSize: "var(--fs-micro)",
                  opacity: unavailable ? 0.5 : 1,
                  cursor: unavailable ? "default" : "pointer",
                }}
                title={busyHere
                  ? `${attachmentUploadStepLabel(busy.step)}中…`
                  : `选择文件上传到「${category.label}」`}
              >
                {busyHere ? `${attachmentUploadStepLabel(busy.step)}中…` : "上传"}
                <input
                  type="file"
                  aria-label={`上传到${category.label}`}
                  accept={category.contentTypes.length > 0 ? category.contentTypes.join(",") : undefined}
                  disabled={unavailable}
                  style={{ display: "none" }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Clearing lets the same file be picked again after a failed
                    // attempt: an input that keeps its value fires no `change`.
                    event.target.value = "";
                    if (file) onSelect(entry, file);
                  }}
                />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
