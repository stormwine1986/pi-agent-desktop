"use client";

// Field rendering shared by the detail view and the create form, so a new
// entity is asked for exactly the fields its type declares and in the same
// controls — one place decides how a `choice` or a long `text` looks.

export const muted = "rgba(128,128,128,0.75)";
export const line = "rgba(128,128,128,0.25)";
export const surface = "rgba(128,128,128,0.06)";
export const danger = "#e5484d";
export const accent = "#3b82f6";

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
 * `datetime` and `user` are edited as text on purpose: the panel has no
 * date-time picker or user search yet, and free text is the honest shape for
 * a value the base parses (ISO 8601 / the referenced user's id or name).
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
export function propertyColumns(property: FieldProperty): string[] {
  const raw = (property as { columns?: unknown }).columns;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((column) => {
      if (typeof column === "string") return column;
      if (typeof column === "object" && column !== null) {
        const name = (column as { name?: unknown }).name;
        return typeof name === "string" ? name : "";
      }
      return "";
    })
    .filter((name) => name.length > 0);
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
export type TableRowDraft = { id?: string } & Record<string, string | undefined>;

/** A draft is text for most fields and rows for a `table` field. */
export type FieldDraft = string | TableRowDraft[];
export type DraftMap = Record<string, FieldDraft>;

export function isTableDraft(value: FieldDraft | undefined): value is TableRowDraft[] {
  return Array.isArray(value);
}

/** Stored value → editable rows, ids preserved. */
export function tableDraftRows(property: FieldProperty, value: unknown): TableRowDraft[] {
  const columns = propertyColumns(property);
  const rows = Array.isArray(value) ? value : typeof value === "object" && value !== null ? [value] : [];
  return rows.map((row) => {
    const record = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    const draft: TableRowDraft = {};
    for (const column of columns) draft[column] = cell(record[column]);
    if (typeof record.id === "string" && record.id) draft.id = record.id;
    return draft;
  });
}

/** A blank row: no id, every declared column empty. */
export function emptyTableRow(property: FieldProperty): TableRowDraft {
  const draft: TableRowDraft = {};
  for (const column of propertyColumns(property)) draft[column] = "";
  return draft;
}

/**
 * Rows for the wire. Only declared columns are sent — the base rejects
 * undeclared ones — plus the row id when it has one.
 */
export function serializeTableRows(property: FieldProperty, rows: TableRowDraft[]): Record<string, string>[] {
  const columns = propertyColumns(property);
  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const column of columns) out[column] = row[column] ?? "";
    if (row.id) out.id = row.id;
    return out;
  });
}

/** Editing a table is row work: add, remove, reorder, change a cell. */
export function TableEditor({ property, rows, onChange, readOnly }: {
  property: FieldProperty;
  rows: TableRowDraft[];
  onChange: (next: TableRowDraft[]) => void;
  readOnly?: boolean;
}) {
  const columns = propertyColumns(property);
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
        <div style={{ fontSize: 11, color: muted }}>还没有行。</div>
      )}
      {rows.map((row, index) => (
        <div
          key={row.id ?? `row-${index}`}
          style={{ border: `1px solid ${line}`, borderRadius: 6, padding: "5px 6px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: muted, fontVariantNumeric: "tabular-nums", minWidth: 14 }}>
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
          {columns.map((column) => {
            const type = columnType(property, column);
            return (
              <label key={column} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                <span style={{ fontSize: 11, color: muted, width: 56, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis" }} title={column}>
                  {column}
                </span>
                <input
                  type={type === "number" ? "number" : type === "date" ? "date" : "text"}
                  value={row[column] ?? ""}
                  onChange={(event) => replaceRow(index, { [column]: event.target.value })}
                  style={{ ...inputStyle, padding: "3px 6px" }}
                />
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
        <div style={{ fontSize: 11, color: danger }}>这个表格字段没有声明列，无法编辑。</div>
      )}
    </div>
  );
}

/** Column type, when the metadata bothers to declare one. */
function columnType(property: FieldProperty, column: string): string {
  const raw = (property as { columns?: unknown }).columns;
  if (!Array.isArray(raw)) return "text";
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as { name?: unknown; type?: unknown };
    if (record.name === column && typeof record.type === "string") return record.type;
  }
  return "text";
}

const miniButton = {
  border: `1px solid ${line}`,
  background: "none",
  color: "inherit",
  borderRadius: 4,
  padding: "0 5px",
  font: "inherit",
  fontSize: 11,
  lineHeight: "18px",
  cursor: "pointer",
} as const;

/** A `table` field's read-only form: a real table, never a JSON blob. */
export function TableValue({ property, value }: { property: FieldProperty; value: unknown }) {
  const columns = propertyColumns(property);
  const rows = tableRows(value, columns);
  if (rows.length === 0) return <span style={{ color: muted }}>—</span>;

  const width = Math.max(columns.length, ...rows.map((row) => row.length));
  // Steps run in order, so a row number is part of the value, not decoration.
  const numbered = true;

  return (
    <div style={{ overflowX: "auto", margin: "2px 0" }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 11,
          lineHeight: 1.45,
          width: "100%",
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            {numbered && <th style={{ ...headCell, width: 22, color: muted, fontWeight: 400 }}>#</th>}
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
                  {row[index] ?? ""}
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
  fontWeight: 600,
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
  fontSize: 12,
  padding: "5px 7px",
} as const;

export const buttonStyle = {
  border: `1px solid ${line}`,
  background: "none",
  color: "inherit",
  borderRadius: 6,
  padding: "3px 10px",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
  whiteSpace: "nowrap",
} as const;

/** A value the panel can show but not edit, with the reason it cannot. */
function InertField({ field, value, reason }: { field: string; value: string; reason: string }) {
  return (
    <div>
      <input value={value} readOnly style={{ ...inputStyle, opacity: 0.75 }} aria-readonly="true" />
      <div role="alert" style={{ color: danger, fontSize: 11, marginTop: 2, lineHeight: 1.4 }}>
        {reason}（字段 {field || "?"}）：只读，无法编辑，也不会被提交。
      </div>
    </div>
  );
}

/** The control a field type maps to. */
export function FieldControl({ property, value, onChange }: {
  property: FieldProperty;
  value: string;
  onChange: (next: string) => void;
}) {
  const type = propertyType(property);
  const values = Array.isArray(property.validValues)
    ? property.validValues.filter((item): item is string => typeof item === "string")
    : [];
  const kind = fieldControlOf(property);

  // Unknown type: show the value, say whose field it is, and do not offer an
  // editor. A free text box here is the one thing the contract forbids — it
  // looks like the panel understood the type (`FM-RENDER` AC-2).
  if (kind === null) {
    return <InertField field={propertyName(property)} value={value} reason={`不认识的字段类型 “${type || "（未声明）"}”`} />;
  }
  // A `choice` with no declared options is a broken definition, not a free text
  // field: accepting an arbitrary string here would let the form write a value
  // the model does not have (same rule as above, for a type we do know).
  if (kind === "select" && values.length === 0) {
    return <InertField field={propertyName(property)} value={value} reason="枚举取值为空" />;
  }

  if (kind === "select" && values.length > 0) {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)} style={inputStyle}>
        <option value="">（未填）</option>
        {values.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  if (kind === "textarea") {
    return (
      <textarea
        value={value}
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
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={6}
        spellCheck={false}
        style={{ ...inputStyle, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11 }}
      />
    );
  }
  return (
    <input
      type={type === "number" ? "number" : type === "date" ? "date" : "text"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      style={inputStyle}
    />
  );
}