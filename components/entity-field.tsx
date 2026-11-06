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

/** How a value of each field type is shown read-only. Unknown types degrade to text. */
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

  if (type === "choice" && values.length > 0) {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)} style={inputStyle}>
        <option value="">（未填）</option>
        {values.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  if (type === "text") {
    return (
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        style={{ ...inputStyle, resize: "vertical" }}
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
