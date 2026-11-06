"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  accent,
  buttonStyle,
  danger,
  FieldControl,
  inputStyle,
  line,
  muted,
  propertyLabel,
  propertyName,
  propertyType,
  surface,
  type FieldProperty,
} from "./entity-field";

interface CreatableType {
  type: string;
  canCreate: boolean;
  requiredFields: string[];
  initialState: string;
}

interface TypeMetadata {
  type: string;
  typeLabel: string;
  properties: FieldProperty[];
  requiredOnCreate: string[];
}

export interface EntityCreateTarget {
  cwd: string;
  server: string;
  workspace: string;
}

/**
 * Creating one entity in a known workspace.
 *
 * The workspace comes from the list the user was looking at — the base refuses
 * to say what may be created without one — and the type menu comes from
 * `list_types`, so a type nobody may create is not offered. Fields are the
 * type's own definition, marked with what the base requires at creation; the
 * form does not decide anything else (`FM-RENDER` ①, `FM-VALIDATE` ③).
 */
export function EntityCreatePanel({ target, onCreated }: {
  target: EntityCreateTarget;
  onCreated: (key: string) => void;
}) {
  const [types, setTypes] = useState<CreatableType[] | null>(null);
  const [type, setType] = useState<string>("");
  const [metadata, setMetadata] = useState<TypeMetadata | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = useMemo(() => new URLSearchParams({
    cwd: target.cwd,
    server: target.server,
    workspace: target.workspace,
  }), [target.cwd, target.server, target.workspace]);

  // The menu: only what this space actually accepts.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      const response = await fetch(`/api/entity/types?${base}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json() as { types?: CreatableType[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      const creatable = (body.types ?? []).filter((item) => item.canCreate);
      setTypes(creatable);
      if (creatable.length === 1) setType(creatable[0].type);
      return creatable;
    })()
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base]);

  // The form follows the chosen type, including its required fields.
  useEffect(() => {
    if (!type) {
      setMetadata(null);
      setDraft({});
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      const params = new URLSearchParams(base);
      params.set("type", type);
      const response = await fetch(`/api/entity/metadata?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json() as TypeMetadata & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setMetadata(body);
      setDraft({});
      return body;
    })()
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, type]);

  const required = useMemo(() => {
    const fromType = metadata?.requiredOnCreate ?? [];
    return new Set(fromType.filter((name): name is string => typeof name === "string"));
  }, [metadata]);

  const submit = useCallback(async () => {
    if (!type || saving) return;
    setSaving(true);
    setError(null);
    try {
      const fields: Record<string, unknown> = {};
      for (const [name, raw] of Object.entries(draft)) {
        if (raw === "") continue;
        const property = metadata?.properties.find((item) => propertyName(item) === name);
        fields[name] = property && propertyType(property) === "number" ? Number(raw) : raw;
      }
      const response = await fetch(`/api/entity/create?${base}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, fields }),
      });
      const body = await response.json() as { key?: string; error?: string };
      if (!response.ok || !body.key) {
        setError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      onCreated(body.key);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [base, draft, metadata, onCreated, saving, type]);

  // A field of type `state` moves by route, never by typing: the base marks it
  // that way (and gives it no permissions), so it is not part of a form.
  const properties = (metadata?.properties ?? []).filter((property) => propertyType(property) !== "state");
  const emptyTypes = types !== null && types.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px 4px",
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 13, whiteSpace: "nowrap" }}>新建实体</strong>
        <span style={{ fontSize: 11, color: muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {target.workspace}
        </span>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!type || saving || emptyTypes}
          style={{ ...buttonStyle, marginLeft: "auto", borderColor: accent, color: accent, opacity: !type || saving ? 0.6 : 1 }}
        >
          {saving ? "创建中…" : "创建"}
        </button>
      </div>

      <div style={{ padding: "0 10px 8px", borderBottom: `1px solid ${line}`, flexShrink: 0 }}>
        <label style={{ display: "block", fontSize: 11, color: muted, marginBottom: 2 }}>类型</label>
        <select
          value={type}
          onChange={(event) => setType(event.target.value)}
          disabled={loading || emptyTypes}
          style={inputStyle}
        >
          <option value="">{emptyTypes ? "这个空间没有可创建的类型" : "选择类型…"}</option>
          {(types ?? []).map((item) => (
            <option key={item.type} value={item.type}>
              {item.type}{item.initialState ? `（初始 ${item.initialState}）` : ""}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            margin: "8px 10px 0",
            padding: "6px 8px",
            border: `1px solid ${danger}`,
            borderRadius: 6,
            background: "rgba(229,72,77,0.08)",
            color: danger,
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 10px 12px" }}>
        {!type && !loading && !emptyTypes && (
          <div style={{ fontSize: 12, color: muted, padding: "4px 0" }}>先选一个类型，再填字段。</div>
        )}
        {properties.map((property) => {
          const name = propertyName(property);
          const isRequired = required.has(name);
          const description = typeof property.description === "string" ? property.description : "";
          return (
            <div
              key={name}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(72px, 32%) 1fr",
                gap: 8,
                padding: "6px 0",
                borderBottom: `1px solid ${line}`,
                fontSize: 12,
                alignItems: "start",
              }}
            >
              <div style={{ color: muted }} title={description || undefined}>
                {propertyLabel(property)}
                {isRequired && <span style={{ color: danger }}> *</span>}
              </div>
              <FieldControl
                property={property}
                value={draft[name] ?? ""}
                onChange={(next) => setDraft((current) => ({ ...current, [name]: next }))}
              />
            </div>
          );
        })}
      </div>

      <div
        style={{
          flexShrink: 0,
          padding: "6px 10px",
          borderTop: `1px solid ${line}`,
          fontSize: 11,
          color: muted,
          background: surface,
        }}
      >
        {required.size > 0 ? `${required.size} 项必填（* 标记）` : "这个类型创建时没有必填项"}
        <div style={{ marginTop: 2 }}>创建之后的字段与状态，都在这个面板里改，不需要回到会话。</div>
      </div>
    </div>
  );
}
