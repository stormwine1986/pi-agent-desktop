"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AppSelect, type AppSelectOption } from "./AppSelect";
import { isImeComposing } from "@/lib/ime";
import {
  memberDetail,
  memberLabel,
  memberOf,
  unknownMembers,
  userValues,
  type WorkspaceMember,
} from "@/lib/entity-members";

// Field rendering shared by the detail view and the create form, so a new
// entity is asked for exactly the fields its type declares and in the same
// controls — one place decides how a `choice` or a long `text` looks.

export const muted = "rgba(128,128,128,0.75)";
export const line = "rgba(128,128,128,0.25)";
export const surface = "rgba(128,128,128,0.06)";
export const danger = "var(--danger)";
export const accent = "var(--accent)";

export interface FieldProperty {
  name?: unknown;
  label?: unknown;
  type?: unknown;
  description?: unknown;
  multiple?: unknown;
  validValues?: unknown;
}

/**
 * How a value is shown read-only. Display always has a form — a value the panel
 * cannot edit is still a value to read; only *editing* refuses an unknown type
 * (see `fieldControlOf`).
 */
export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean).join("、");
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function propertyName(property: FieldProperty): string {
  return typeof property.name === "string" ? property.name : "";
}

export function propertyLabel(property: FieldProperty): string {
  const label = typeof property.label === "string" ? property.label : "";
  return label || propertyName(property);
}

export function propertyType(property: FieldProperty): string {
  return typeof property.type === "string" ? property.type : "";
}

/**
 * The control each field type is edited with.
 *
 * This is a **capability** list, not a validator, and the difference matters
 * (`FM-RENDER` AC-4): the base owns which types exist — `SSR-000053`
 * (DAT-SCHEMA) declares a closed set of nine — and it may add one before this
 * panel learns to draw it. Rejecting a definition because we cannot render it
 * would block a perfectly valid type, and any list we hard-code as "valid"
 * drifts the day the base ships a tenth. So a type missing from this table is
 * shown **read-only with its name** instead of a text box that pretends to be
 * its editor; whether a type is *legal* stays the base's call, not ours.
 *
 * `datetime` is edited as text on purpose: the panel has no date-time picker
 * yet, and free text is the honest shape for a value the base parses (ISO 8601).
 *
 * `user` is listed as `text` for one reason only — it is the **degraded** path
 * (`SSR-000093` ⑦): when the member list cannot be read, the field falls back to
 * a text box that says so. When the list is available the same type is drawn by
 * `UserField` as a member picker, and this table is not consulted for the
 * control — only for "is this a type the panel knows at all".
 */
export const FIELD_CONTROLS: Record<string, "select" | "textarea" | "text" | "table"> = {
  shorttext: "text",
  text: "textarea",
  number: "text",
  date: "text",
  datetime: "text",
  user: "text",
  choice: "select",
  state: "text",
  table: "table",
};

/** The editor for this field, or null when the panel does not know the type. */
export function fieldControlOf(property: FieldProperty): "select" | "textarea" | "text" | "table" | null {
  return FIELD_CONTROLS[propertyType(property)] ?? null;
}

/** A `user` field references a workspace member; its value is a username. */
export function isUserProperty(property: FieldProperty): boolean {
  return propertyType(property) === "user";
}

/** Whether a field holds many values (`multiple: true` in the model). */
export function isMultipleProperty(property: FieldProperty): boolean {
  return property.multiple === true;
}

/**
 * Whether this field — or a `table` column inside it — references members, so
 * the panel knows if the member list is worth reading at all.
 */
export function propertyNeedsMembers(property: FieldProperty): boolean {
  return isUserProperty(property) || columnDeclarations(property).some((column) => column.type === "user");
}

/**
 * Stored value → the draft a `user` control edits (`SSR-000093` ⑤).
 *
 * A single-value field is a username string; a multi-value field is an array.
 * A single-value field that *holds* an array is passed through as an array on
 * purpose: collapsing it to `"a、b"` would invent a username nobody has, so the
 * field shows the mismatch and leaves the judgement to the base.
 */
export function userDraftValue(property: FieldProperty, value: unknown): FieldDraftValue {
  const values = userValues(value);
  if (isMultipleProperty(property)) return values;
  if (typeof value === "string") return value;
  return values.length > 0 ? values : "";
}

/**
 * One row of the form, and where it came from.
 *
 * `property` is the metadata entry **verbatim**, so a panel can hand it straight
 * to a control, and a comparison script can diff the form's list against
 * `get_metadata` without the panel having interpreted anything
 * (`FM-RENDER` ①).
 */
export interface FieldDescriptor {
  property: FieldProperty;
  name: string;
  /** The declared label, verbatim (`""` when the model declares none). */
  label: string;
  /** The declared type, verbatim. */
  type: string;
  /** The declared options, in the model's order. */
  validValues: string[];
}

/**
 * The form's field list, and the only way a panel builds one: every row is a
 * field the type declares, in the declared order, with nothing added and
 * nothing dropped (`FM-RENDER` ①②). A field with no name cannot be addressed, so
 * it is skipped rather than shown unlabelled.
 */
export function fieldDescriptorsOf(properties: unknown): FieldDescriptor[] {
  if (!Array.isArray(properties)) return [];
  const descriptors: FieldDescriptor[] = [];
  for (const raw of properties) {
    if (typeof raw !== "object" || raw === null) continue;
    const property = raw as FieldProperty;
    const name = propertyName(property);
    if (!name) continue;
    const validValues = Array.isArray(property.validValues)
      ? property.validValues.filter((item): item is string => typeof item === "string")
      : [];
    descriptors.push({
      property,
      name,
      label: typeof property.label === "string" ? property.label : "",
      type: propertyType(property),
      validValues,
    });
  }
  return descriptors;
}

/**
 * A `table` field declares its columns in metadata (`columns: [{ name }]`), and
 * the server rejects rows with undeclared columns. The panel needs the same
 * list to draw a header — and to know which cell belongs to which column.
 */
/** What a `table` column declares: a name, and optionally a type and `multiple`. */
export interface ColumnDeclaration {
  name: string;
  /** Declared column type; `text` when the model does not say. */
  type: string;
  multiple: boolean;
}

/**
 * The declared columns, in the model's order.
 *
 * A column may declare a `type` (`user` included) and `multiple`; a cell is then
 * edited with that type's control, which is what `SSR-000093` ⑥ asks for.
 */
export function columnDeclarations(property: FieldProperty): ColumnDeclaration[] {
  const raw = (property as { columns?: unknown }).columns;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((column) => {
    if (typeof column === "string") return column ? [{ name: column, type: "text", multiple: false }] : [];
    if (typeof column !== "object" || column === null) return [];
    const record = column as { name?: unknown; type?: unknown; multiple?: unknown };
    const name = typeof record.name === "string" ? record.name : "";
    if (!name) return [];
    return [{
      name,
      type: typeof record.type === "string" ? record.type : "text",
      multiple: record.multiple === true,
    }];
  });
}

export function propertyColumns(property: FieldProperty): string[] {
  return columnDeclarations(property).map((column) => column.name);
}

export function isTableProperty(property: FieldProperty): boolean {
  return propertyType(property) === "table";
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Rows for display, shaped to the declared columns.
 *
 * Accepts what the base actually returns (objects keyed by column name) and the
 * shapes a hand-written draft may produce (arrays, a single object), so a table
 * still renders instead of falling back to JSON the moment it is slightly off.
 * Unknown keys are dropped — the server would reject them anyway.
 */
export function tableRows(value: unknown, columns: string[]): string[][] {
  const rows = Array.isArray(value) ? value : typeof value === "object" && value !== null ? [value] : [];
  return rows.map((row) => {
    if (Array.isArray(row)) return columns.map((_, position) => cell(row[position]));
    if (typeof row === "object" && row !== null) {
      const record = row as Record<string, unknown>;
      return columns.length > 0
        ? columns.map((name) => cell(record[name]))
        : Object.values(record).map(cell);
    }
    return columns.map((_, position) => (position === 0 ? cell(row) : ""));
  });
}

/** Draft text → rows. Empty means "clear the table", not "leave it alone". */
/**
 * One row while it is being edited. Declared columns are strings; `id` is the
 * base's own row identity and is carried through untouched, because a row that
 * loses its id comes back as a new row (SR-000015).
 */
export type TableRowDraft = { id?: string } & Record<string, string | string[] | undefined>;

/**
 * A draft holds what its control edits: text for most fields, a username list
 * for a multi-value `user` field (`SSR-000093` ⑤), rows for a `table`.
 */
export type FieldDraftValue = string | string[];
export type FieldDraft = FieldDraftValue | TableRowDraft[];
export type DraftMap = Record<string, FieldDraft>;

/** Rows are objects, so a username list is never mistaken for a table. */
export function isTableDraft(value: FieldDraft | undefined): value is TableRowDraft[] {
  return Array.isArray(value) && value.every((row) => typeof row === "object" && row !== null);
}

/** Stored value → editable rows, ids preserved. */
export function tableDraftRows(property: FieldProperty, value: unknown): TableRowDraft[] {
  const declarations = columnDeclarations(property);
  const rows = Array.isArray(value) ? value : typeof value === "object" && value !== null ? [value] : [];
  return rows.map((row) => {
    const record = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    const draft: TableRowDraft = {};
    for (const declaration of declarations) {
      // A `user` cell is the reference itself, never its display form: an array
      // column keeps its array, a single column its username.
      draft[declaration.name] = declaration.type === "user"
        ? userDraftValue({ name: declaration.name, type: "user", multiple: declaration.multiple }, record[declaration.name])
        : cell(record[declaration.name]);
    }
    if (typeof record.id === "string" && record.id) draft.id = record.id;
    return draft;
  });
}

/** A blank row: no id, every declared column empty (an array column starts empty). */
export function emptyTableRow(property: FieldProperty): TableRowDraft {
  const draft: TableRowDraft = {};
  for (const declaration of columnDeclarations(property)) {
    draft[declaration.name] = declaration.type === "user" && declaration.multiple ? [] : "";
  }
  return draft;
}

/**
 * Rows for the wire. Only declared columns are sent — the base rejects
 * undeclared ones — plus the row id when it has one. A `user` cell goes back in
 * its own shape (username, or usernames for a multi-value column), never as the
 * display text the table showed (`SSR-000093` ⑤ ⑥).
 */
export function serializeTableRows(property: FieldProperty, rows: TableRowDraft[]): Record<string, unknown>[] {
  const declarations = columnDeclarations(property);
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const declaration of declarations) {
      const value = row[declaration.name];
      out[declaration.name] = Array.isArray(value)
        ? (declaration.type === "user" ? userValues(value) : value)
        : value ?? "";
    }
    if (row.id) out.id = row.id;
    return out;
  });
}

/**
 * Read-only rows aligned to the declared columns, usernames kept as they are
 * stored so a `user` cell can be shown by name without losing the value.
 */
export function tableValueRows(property: FieldProperty, value: unknown): (string | string[])[][] {
  const declarations = columnDeclarations(property);
  const rows = Array.isArray(value) ? value : typeof value === "object" && value !== null ? [value] : [];
  return rows.map((row) => {
    if (Array.isArray(row)) return declarations.map((_, position) => cell(row[position]));
    if (typeof row === "object" && row !== null) {
      const record = row as Record<string, unknown>;
      return declarations.length > 0
        ? declarations.map((declaration) => {
          const cellValue = record[declaration.name];
          return Array.isArray(cellValue)
            ? userValues(cellValue)
            : cell(cellValue);
        })
        : Object.values(record).map(cell);
    }
    return declarations.map((_, position) => (position === 0 ? cell(row) : ""));
  });
}

/** Editing a table is row work: add, remove, reorder, change a cell. */
export function TableEditor({ property, rows, onChange, readOnly }: {
  property: FieldProperty;
  rows: TableRowDraft[];
  onChange: (next: TableRowDraft[]) => void;
  readOnly?: boolean;
}) {
  const declarations = columnDeclarations(property);
  const columns = declarations.map((column) => column.name);
  const label = propertyLabel(property);

  const replaceRow = (index: number, patch: Partial<TableRowDraft>) => {
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index: number) => onChange(rows.filter((_, position) => position !== index));
  const moveRow = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
  };

  if (readOnly) return <TableValue property={property} value={serializeTableRows(property, rows)} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.length === 0 && (
        <div style={{ fontSize: "var(--fs-micro)", color: muted }}>还没有行。</div>
      )}
      {rows.map((row, index) => (
        <div
          key={row.id ?? `row-${index}`}
          style={{ border: `1px solid ${line}`, borderRadius: 6, padding: "5px 6px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
            <span style={{ fontSize: "var(--fs-micro)", color: muted, fontVariantNumeric: "tabular-nums", minWidth: 14 }}>
              {index + 1}
            </span>
            <span style={{ flex: 1 }} />
            {[
              { text: "↑", title: "上移", delta: -1, disabled: index === 0 },
              { text: "↓", title: "下移", delta: 1, disabled: index === rows.length - 1 },
            ].map((action) => (
              <button
                key={action.text}
                type="button"
                title={action.title}
                aria-label={`${label}第 ${index + 1} 行${action.title}`}
                disabled={action.disabled}
                onClick={() => moveRow(index, action.delta)}
                style={{ ...miniButton, opacity: action.disabled ? 0.35 : 1 }}
              >
                {action.text}
              </button>
            ))}
            <button
              type="button"
              title="删除这一行"
              aria-label={`删除${label}第 ${index + 1} 行`}
              onClick={() => removeRow(index)}
              style={{ ...miniButton, color: danger }}
            >
              ✕
            </button>
          </div>
          {declarations.map((declaration) => {
            const column = declaration.name;
            const isUser = declaration.type === "user";
            return (
              <label key={column} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                <span style={{ fontSize: "var(--fs-micro)", color: muted, width: 56, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={column}>
                  {column}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  {isUser ? (
                    // Same control and same candidate list as a top-level field
                    // (`SSR-000093` ⑥): a cell is a member reference too.
                    <UserField
                      property={{ name: column, type: "user", multiple: declaration.multiple }}
                      value={row[column] ?? (declaration.multiple ? [] : "")}
                      onChange={(next) => replaceRow(index, { [column]: next })}
                    />
                  ) : (
                    <input
                      type={declaration.type === "number" ? "number" : declaration.type === "date" ? "date" : "text"}
                      value={typeof row[column] === "string" ? row[column] as string : ""}
                      onChange={(event) => replaceRow(index, { [column]: event.target.value })}
                      style={{ ...inputStyle, padding: "3px 6px" }}
                    />
                  )}
                </div>
              </label>
            );
          })}
        </div>
      ))}
      {columns.length > 0 ? (
        <button
          type="button"
          onClick={() => onChange([...rows, emptyTableRow(property)])}
          style={{ ...buttonStyle, alignSelf: "flex-start" }}
        >
          + 添加一行
        </button>
      ) : (
        <div style={{ fontSize: "var(--fs-micro)", color: danger }}>这个表格字段没有声明列，无法编辑。</div>
      )}
    </div>
  );
}

const miniButton = {
  border: `1px solid ${line}`,
  background: "none",
  color: "inherit",
  borderRadius: 4,
  padding: "0 5px",
  font: "inherit",
  fontSize: "var(--fs-micro)",
  lineHeight: "18px",
  cursor: "pointer",
} as const;

/** A `table` field's read-only form: a real table, never a JSON blob. */
export function TableValue({ property, value }: { property: FieldProperty; value: unknown }) {
  const declarations = columnDeclarations(property);
  const columns = declarations.map((column) => column.name);
  // Usernames stay raw here so a `user` cell can be shown by name (`SSR-000093` ⑥).
  const rows = tableValueRows(property, value);
  if (rows.length === 0) return <span style={{ color: muted }}>—</span>;

  const width = Math.max(columns.length, ...rows.map((row) => row.length));
  // Steps run in order, so a row number is part of the value, not decoration.
  const numbered = true;

  return (
    <div style={{ overflowX: "auto", margin: "2px 0" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: "var(--fs-micro)",
          lineHeight: 1.45,
          width: "100%",
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            {numbered && <th style={{ ...headCell, width: 22, color: muted, fontWeight: "var(--fw-regular)" }}>#</th>}
            {Array.from({ length: width }, (_, index) => (
              <th key={index} style={headCell}>
                {columns[index] ?? `列${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {numbered && (
                <td style={{ ...bodyCell, color: muted, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {rowIndex + 1}
                </td>
              )}
              {Array.from({ length: width }, (_, index) => (
                <td key={index} style={bodyCell}>
                  {declarations[index]?.type === "user"
                    ? <UserValue value={row[index]} />
                    : row[index] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const headCell = {
  textAlign: "left" as const,
  verticalAlign: "bottom" as const,
  padding: "3px 5px",
  borderBottom: `1px solid ${line}`,
  fontWeight: "var(--fw-semibold)",
  whiteSpace: "nowrap" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const bodyCell = {
  verticalAlign: "top" as const,
  padding: "3px 5px",
  borderBottom: `1px solid ${line}`,
  wordBreak: "break-word" as const,
  whiteSpace: "pre-wrap" as const,
};

export const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  border: `1px solid ${line}`,
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: "var(--fs-caption)",
  padding: "5px 7px",
} as const;

export const buttonStyle = {
  border: `1px solid ${line}`,
  background: "none",
  color: "inherit",
  borderRadius: 6,
  padding: "3px 10px",
  font: "inherit",
  fontSize: "var(--fs-caption)",
  cursor: "pointer",
  whiteSpace: "nowrap",
} as const;

/** A value the panel can show but not edit, with the reason it cannot. */
function InertField({ field, value, reason }: { field: string; value: string; reason: string }) {
  return (
    <div>
      <input value={value} readOnly style={{ ...inputStyle, opacity: 0.75 }} aria-readonly="true" />
      <div role="alert" style={{ color: danger, fontSize: "var(--fs-micro)", marginTop: 2, lineHeight: 1.4 }}>
        {reason}（字段 {field || "?"}）：只读，无法编辑，也不会被提交。
      </div>
    </div>
  );
}

/**
 * Workspace members, provided by whoever knows which workspace is on screen.
 *
 * The panel reads them once per (project, channel, workspace) and hands them
 * down, so a `user` field never fetches on its own and two fields on one form
 * cannot end up with two different candidate lists (`SSR-000093` ②).
 */
export interface MemberDirectory {
  status: "idle" | "loading" | "ready" | "unavailable";
  members: WorkspaceMember[];
  error?: string;
}

const noDirectory: MemberDirectory = { status: "unavailable", members: [] };

const MemberDirectoryContext = createContext<MemberDirectory>(noDirectory);

export function MemberDirectoryProvider({ directory, children }: { directory: MemberDirectory; children: ReactNode }) {
  return <MemberDirectoryContext.Provider value={directory}>{children}</MemberDirectoryContext.Provider>;
}

export function useMemberDirectory(): MemberDirectory {
  return useContext(MemberDirectoryContext);
}

const noteStyle = {
  fontSize: "var(--fs-micro)",
  color: muted,
  marginTop: 2,
  lineHeight: 1.4,
} as const;

const unknownTagStyle = {
  display: "inline-block",
  marginLeft: 3,
  padding: "0 3px",
  border: `1px solid ${line}`,
  borderRadius: 3,
  fontSize: "var(--fs-micro)",
  color: danger,
  lineHeight: 1.5,
} as const;

/**
 * A stored `user` value, read-only.
 *
 * Shows the member's display name with the username on hover, and marks a
 * username the member list does not know **without hiding or clearing it** —
 * someone who left the workspace still owns what they own (`SSR-000093` ③).
 * When the list itself could not be read there is nothing to judge against, so
 * the raw username is shown unmarked.
 */
export function UserValue({ value }: { value: unknown }) {
  const directory = useMemberDirectory();
  const values = userValues(value);
  if (values.length === 0) return <span style={{ color: muted }}>—</span>;
  const judgeable = directory.status === "ready";

  return (
    <span>
      {values.map((username, index) => {
        const member = memberOf(directory.members, username);
        const unknown = judgeable && !member;
        return (
          <span key={username}>
            {index > 0 && "、"}
            <span title={username}>{member ? memberLabel(member) : username}</span>
            {unknown && (
              <span style={unknownTagStyle} title="这个 username 不在当前成员清单里，值原样保留">
                未知成员
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The editor for a `user` field: a member picker whose candidates are the base's
 * member list, whose visible text is the display name, and whose **value is the
 * username** (`SSR-000093` ①②⑤).
 *
 * It degrades on purpose (`⑦`): no list means a text box that says so — never a
 * silent free-text field, and never an empty dropdown that would read as
 * "nobody is a member". A username is never pre-judged here; that stays the
 * base's call (`④`).
 */
export function UserField({ property, value, onChange }: {
  property: FieldProperty;
  value: FieldDraftValue;
  onChange: (next: FieldDraftValue) => void;
}) {
  const directory = useMemberDirectory();
  const label = propertyLabel(property) || propertyName(property);
  const multiple = isMultipleProperty(property);
  const values = userValues(value);
  const asText = typeof value === "string" ? value : values.join(" ");

  if (directory.status === "unavailable") {
    return (
      <div>
        <input
          type="text"
          aria-label={label}
          value={asText}
          onChange={(event) => onChange(event.target.value)}
          style={inputStyle}
        />
        <div role="status" title={directory.error} style={noteStyle}>
          ⚠ 未能读取成员清单（暂时按文本填写，判定仍在基座）
        </div>
      </div>
    );
  }
  if (directory.status !== "ready") {
    // Loading is not "unavailable": a text box now would invite the blind typing
    // the list was about to prevent.
    return (
      <input
        type="text"
        aria-label={label}
        value={asText}
        readOnly
        disabled
        placeholder="正在读取成员清单…"
        style={{ ...inputStyle, opacity: 0.6 }}
      />
    );
  }

  // A single-value field holding several usernames is not a list of one: show it
  // as the mismatch it is instead of joining it into a username nobody has.
  if (!multiple && Array.isArray(value) && values.length > 1) {
    return <InertField field={label} value={values.join("、")} reason="这个字段声明为单选，但值是多个 username" />;
  }

  if (multiple) {
    return <UserMultiPicker label={label} members={directory.members} value={values} onChange={onChange} />;
  }

  const options: AppSelectOption[] = [{ value: "", label: "（未填）" }];
  const current = values[0] ?? "";
  if (current && !memberOf(directory.members, current)) {
    options.push({
      value: current,
      label: `${current}（未知成员）`,
      description: "不在当前成员清单里，原值保留",
    });
  }
  for (const member of directory.members) {
    options.push({ value: member.username, label: memberLabel(member), description: memberDetail(member) });
  }

  return (
    <AppSelect
      value={current}
      onValueChange={(next) => onChange(next)}
      aria-label={label}
      options={options}
    />
  );
}

/**
 * A multi-value `user` field: the same `.app-menu` surface and the same
 * candidates as the single picker, with toggling and dedupe
 * (`SSR-000093` ①⑤).
 */
function UserMultiPicker({ label, members, value, onChange }: {
  label: string;
  members: readonly WorkspaceMember[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect() ?? null;
    setAnchor(rect);
    setOpen((current) => !current);
  };

  const toggle = (username: string) => {
    onChange(value.includes(username) ? value.filter((item) => item !== username) : [...value, username]);
  };

  // A username the list does not know is still a value: it stays selectable and
  // removable, marked, never dropped (`③`).
  const unknown = unknownMembers(value, members);
  const rows = [
    ...members.map((member) => ({
      username: member.username,
      label: memberLabel(member),
      detail: memberDetail(member),
      known: true,
    })),
    ...unknown.map((username) => ({
      username,
      label: username,
      detail: "不在当前成员清单里，原值保留",
      known: false,
    })),
  ];
  const summary = value.length === 0
    ? "（未填）"
    : rows
      .filter((row) => value.includes(row.username))
      .map((row) => (row.known ? row.label : `${row.username}（未知成员）`))
      .join("、");

  const width = anchor ? Math.min(Math.max(anchor.width, 240), window.innerWidth - 16) : 240;
  const above = anchor
    ? window.innerHeight - anchor.bottom < 220 && anchor.top > window.innerHeight - anchor.bottom
    : false;

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        className="app-select-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={show}
      >
        <span>{summary}</span>
        <span className="app-select-chevron">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
            <path d="m7 10 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open && anchor && createPortal(
        <div
          ref={panelRef}
          id={menuId}
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="native-popover app-menu app-select-menu app-combobox-menu"
          style={{
            width,
            left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)),
            ...(above ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }),
            maxHeight: Math.max(120, Math.min(320, (above ? anchor.top : window.innerHeight - anchor.bottom) - 14)),
          }}
          onKeyDown={(event) => {
            if (isImeComposing(event)) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {rows.length === 0 && (
            <div style={{ ...noteStyle, padding: "6px 10px" }}>这个空间没有可选的成员。</div>
          )}
          {rows.map((row) => (
            <button
              key={row.username}
              type="button"
              role="option"
              aria-selected={value.includes(row.username)}
              className="app-menu-option"
              onClick={() => toggle(row.username)}
            >
              <span className="app-menu-copy">
                {row.known ? row.label : `${row.username}（未知成员）`}
                {row.detail && <small>{row.detail}</small>}
              </span>
            </button>
          ))}
          {value.length > 0 && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="app-menu-option"
              onClick={() => onChange([])}
            >
              <span className="app-menu-copy">清空<small>把这几个成员引用一起去掉</small></span>
            </button>
          )}
        </div>, document.body,
      )}
    </div>
  );
}

/** The control a field type maps to. */
export function FieldControl({ property, value, onChange }: {
  property: FieldProperty;
  /** A draft row for a `table` field never reaches this control, but the union
   * keeps the panels free to pass whatever their draft holds. */
  value: FieldDraft | undefined;
  onChange: (next: FieldDraftValue) => void;
}) {
  const type = propertyType(property);
  const values = Array.isArray(property.validValues)
    ? property.validValues.filter((item): item is string => typeof item === "string")
    : [];
  const kind = fieldControlOf(property);
  // A `user` field may hold several usernames; every other control edits text.
  const draftValue: FieldDraftValue = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : "";
  const asText = typeof draftValue === "string" ? draftValue : formatValue(draftValue);

  // Unknown type: show the value, say whose field it is, and do not offer an
  // editor. A free text box here is the one thing the contract forbids — it
  // looks like the panel understood the type (`FM-RENDER` AC-2).
  if (kind === null) {
    return <InertField field={propertyName(property)} value={asText} reason={`不认识的字段类型 “${type || "（未声明）"}”`} />;
  }
  // `user` is its own control: a member picker, or the text fallback that says
  // it could not read the member list (`SSR-000093` ⑦). Its `text` entry in
  // `FIELD_CONTROLS` is only that degraded path.
  if (isUserProperty(property)) {
    return <UserField property={property} value={draftValue} onChange={onChange} />;
  }
  // A `choice` with no declared options is a broken definition, not a free text
  // field: accepting an arbitrary string here would let the form write a value
  // the model does not have (same rule as above, for a type we do know).
  if (kind === "select" && values.length === 0) {
    return <InertField field={propertyName(property)} value={asText} reason="枚举取值为空" />;
  }

  if (kind === "select" && values.length > 0) {
    return (
      <AppSelect
        value={asText}
        onValueChange={onChange}
        aria-label={propertyLabel(property) || propertyName(property)}
        options={[{ value: "", label: "（未填）" }, ...values.map((option) => ({ value: option, label: option }))]}
      />
    );
  }
  if (kind === "textarea") {
    return (
      <textarea
        value={asText}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        style={{ ...inputStyle, resize: "vertical" }}
      />
    );
  }
  if (kind === "table") {
    // Rows are edited as JSON on purpose: a cell-by-cell editor is a different
    // feature, and it would have to guess at columns the server validates.
    return (
      <textarea
        value={asText}
        onChange={(event) => onChange(event.target.value)}
        rows={6}
        spellCheck={false}
        style={{ ...inputStyle, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "var(--fs-micro)" }}
      />
    );
  }
  return (
    <input
      type={type === "number" ? "number" : type === "date" ? "date" : "text"}
      value={asText}
      onChange={(event) => onChange(event.target.value)}
      style={inputStyle}
    />
  );
}