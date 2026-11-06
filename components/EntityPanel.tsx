"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  accent,
  buttonStyle,
  danger,
  FieldControl,
  formatValue,
  inputStyle,
  line,
  muted,
  propertyLabel,
  propertyName,
  propertyType,
  surface,
  type FieldProperty,
} from "./entity-field";

/** The shape `GET /api/entity` answers (kept in step with `app/api/entity/route.ts`). */
interface RelationRow {
  key: string;
  type: string;
  name: string;
  state: string;
  linkType: string;
}

interface EntityResponse {
  /** The channel that answered; a channel-less link learns it on first read. */
  server: string;
  workspace: string;
  type: string;
  key: string;
  typeLabel: string;
  name: string;
  state: string;
  revision: number;
  fields: Record<string, unknown>;
  hiddenFields: string[];
  properties: FieldProperty[];
  lifecycle: unknown;
  roles: string[];
  writableFields: string[];
  /** Transitions open to this reader from the current state. */
  routes: AvailableRoute[];
}

/** A transition the base allows from the current state. */
interface AvailableRoute {
  name: string;
  to: string;
  /** The route's requirements plus everything the destination state requires. */
  required: string[];
}

export interface EntityTarget {
  cwd: string;
  /** Absent when the link named no channel: the server resolves it. */
  server?: string;
  workspace?: string;
  key: string;
}

/** A draft starts from what the server holds, as text the inputs can display. */
function draftOf(data: EntityResponse): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const property of data.properties) {
    const name = propertyName(property);
    if (!name) continue;
    const value = data.fields[name];
    draft[name] = value === undefined || value === null ? "" : formatValue(value);
  }
  return draft;
}

/** Only what changed, so a save cannot touch fields the user never looked at. */
function changedFields(data: EntityResponse, draft: Record<string, string>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const property of data.properties) {
    const name = propertyName(property);
    if (!name || !(name in draft)) continue;
    const before = data.fields[name];
    const beforeText = before === undefined || before === null ? "" : formatValue(before);
    if (draft[name] === beforeText) continue;
    // Numbers go back as numbers; everything else stays a string and lets the
    // server reject what it does not accept (`FM-VALIDATE`).
    changed[name] = propertyType(property) === "number" && draft[name].trim() !== ""
      ? Number(draft[name])
      : draft[name];
  }
  return changed;
}

/**
 * One entity: read it, or edit the fields this reader may change.
 *
 * The field list comes from `get_metadata`, not from the entity's own keys: a
 * field that was never filled would otherwise disappear, and "未填写" would
 * look the same as "无权查看" (`FM-RENDER` ①, `FM-FIELD-PERM` ⑦).
 *
 * Editing sends only the changed fields with the revision this panel read, and
 * the server keeps the last word — the form never pre-judges what it accepts
 * (`FM-SUBMIT` ③, `FM-VALIDATE` ③).
 */
export function EntityPanel({ target, onOpenEntity }: {
  target: EntityTarget;
  /** Open a related entity in its own tab. */
  onOpenEntity?: (ref: { server?: string; workspace?: string; key: string }) => void;
}) {
  const [data, setData] = useState<EntityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // The transition being prepared, and the values its destination requires.
  const [pendingRoute, setPendingRoute] = useState<AvailableRoute | null>(null);
  const [routeDraft, setRouteDraft] = useState<Record<string, string>>({});
  const [routeError, setRouteError] = useState<string | null>(null);
  // One hop of traceability: what this entity depends on, and what depends on it.
  const [traces, setTraces] = useState<{ upstream: RelationRow[]; downstream: RelationRow[] } | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  // One panel, two views of the same entity: its own fields, or its place in
  // the chain. Both are read-only until asked otherwise.
  const [tab, setTab] = useState<"attr" | "relations">("attr");

  const query = useMemo(() => {
    const params = new URLSearchParams({ cwd: target.cwd, key: target.key });
    // Left out when unknown: the route then asks the project's servers.
    if (target.server) params.set("server", target.server);
    if (target.workspace) params.set("workspace", target.workspace);
    return params;
  }, [target.cwd, target.server, target.workspace, target.key]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/entity?${query}`, { cache: "no-store", signal });
    const body = await response.json() as EntityResponse & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void load(controller.signal)
      .then((body) => {
        setData(body);
        setDraft(draftOf(body));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);

  // Loaded once the entity is known: the traces need the resolved channel, which
  // a channel-less link only learns after the first read.
  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    setTraceError(null);
    void (async () => {
      const params = new URLSearchParams({ cwd: target.cwd, server: data.server, key: data.key });
      const response = await fetch(`/api/entity/traces?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json() as { upstream?: RelationRow[]; downstream?: RelationRow[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setTraces({ upstream: body.upstream ?? [], downstream: body.downstream ?? [] });
      return body;
    })().catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setTraceError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => controller.abort();
  }, [data, target.cwd]);

  const writable = useMemo(() => new Set(data?.writableFields ?? []), [data]);

  /**
   * One list per relation, keyed by direction and link type.
   *
   * Mixing every downstream link into one list hides which kind it is, and the
   * base names the kinds itself — so the grouping uses its names rather than a
   * table of ours.
   */
  const relationGroups = useMemo(() => {
    const groups = new Map<string, { direction: string; linkType: string; rows: RelationRow[] }>();
    const sides: Array<[string, RelationRow[]]> = [
      ["upstream", traces?.upstream ?? []],
      ["downstream", traces?.downstream ?? []],
    ];
    for (const [direction, rows] of sides) {
      for (const row of rows) {
        const id = `${direction}:${row.linkType}`;
        const group = groups.get(id) ?? { direction, linkType: row.linkType, rows: [] };
        group.rows.push(row);
        groups.set(id, group);
      }
    }
    return [...groups.values()];
  }, [traces]);
  const changed = data ? changedFields(data, draft) : {};
  const changedCount = Object.keys(changed).length;

  const startEditing = () => {
    if (!data) return;
    setDraft(draftOf(data));
    setSaveError(null);
    setConflict(false);
    setEditing(true);
  };

  const cancelEditing = () => {
    if (saving) return;
    setEditing(false);
    setSaveError(null);
    setConflict(false);
    if (data) setDraft(draftOf(data));
  };

  const save = async () => {
    if (!data || saving) return;
    if (changedCount === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    try {
      const response = await fetch(`/api/entity?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fields: changed, expectedRevision: data.revision }),
      });
      const body = await response.json() as EntityResponse & { error?: string; conflict?: boolean };
      if (!response.ok) {
        // Keep the draft: throwing away what the user typed to show an error is
        // worse than leaving it on screen beside the message.
        setConflict(Boolean(body.conflict));
        setSaveError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      setData(body);
      setDraft(draftOf(body));
      setEditing(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    try {
      const body = await load();
      setData(body);
      setDraft(draftOf(body));
      setEditing(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  /** Fields the destination still needs before the base will take the route. */
  const missingFor = (route: AvailableRoute): string[] => {
    if (!data) return [];
    return route.required.filter((name) => {
      const value = data.fields[name];
      return value === undefined || value === null || value === "";
    });
  };

  const submitRoute = async (route: AvailableRoute, values: Record<string, unknown>) => {
    if (!data || saving) return;
    setSaving(true);
    setRouteError(null);
    setSaveError(null);
    setConflict(false);
    try {
      const response = await fetch(`/api/entity?${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetState: route.to, fields: values, expectedRevision: data.revision }),
      });
      const body = await response.json() as EntityResponse & { error?: string; conflict?: boolean };
      if (!response.ok) {
        setConflict(Boolean(body.conflict));
        if (body.conflict) setSaveError(body.error ?? null);
        else setRouteError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      setData(body);
      setDraft(draftOf(body));
      setPendingRoute(null);
      setRouteDraft({});
    } catch (cause) {
      setRouteError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Starts a transition: straight through when the destination is already
   * satisfied, otherwise by asking for exactly the fields it still needs.
   */
  const beginRoute = (route: AvailableRoute) => {
    if (!data || saving) return;
    const missing = missingFor(route);
    setRouteError(null);
    if (missing.length === 0) {
      void submitRoute(route, {});
      return;
    }
    setPendingRoute(route);
    setRouteDraft({});
  };

  if (loading && !data) {
    return <div style={{ padding: 12, fontSize: 12, color: muted }}>正在读取 {target.key}…</div>;
  }

  if (error) {
    return (
      <div style={{ padding: 12, fontSize: 12, color: danger }}>
        <div>{target.key}：{error}</div>
        <div style={{ marginTop: 6, color: muted }}>
          字段可能读得到，但类型定义或实体本身没取到；表单要求元数据齐备，缺一条不渲染（FM-META ①）。
        </div>
      </div>
    );
  }

  if (!data) return null;

  const hidden = new Set(data.hiddenFields);
  const properties: FieldProperty[] = data.properties.length > 0
    ? data.properties
    : Object.keys(data.fields).map((name) => ({ name }));
  const visible = properties.filter((property) => !hidden.has(propertyName(property)));
  const unfilled = visible.filter((property) => data.fields[propertyName(property)] === undefined);
  const canEdit = data.writableFields.length > 0;
  const relationCount = (traces?.upstream.length ?? 0) + (traces?.downstream.length ?? 0);
  /** Numbers leave the form as numbers; the base rejects the rest. */
  const coerce = (name: string, raw: string): unknown => {
    const property = properties.find((item) => propertyName(item) === name);
    return propertyType(property ?? {}) === "number" && raw.trim() !== "" ? Number(raw) : raw;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      {/* Two rows: the key and the actions need to stay intact in a narrow
          panel, and a single row squeezed the name, the meta and the buttons
          into wrapping fragments. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px 4px",
          flexShrink: 0,
        }}
      >
        <strong style={{ fontSize: 13, whiteSpace: "nowrap", flexShrink: 0 }}>{data.key}</strong>
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6, flexShrink: 0 }}>
          {!editing && canEdit && (
            <button type="button" onClick={startEditing} style={buttonStyle} title={`编辑 ${data.key}`}>
              编辑
            </button>
          )}
          {editing && (
            <>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                style={{ ...buttonStyle, borderColor: accent, color: accent, opacity: saving ? 0.6 : 1 }}
              >
                {saving ? "保存中…" : changedCount > 0 ? `保存 ${changedCount} 项` : "保存"}
              </button>
              <button type="button" onClick={cancelEditing} disabled={saving} style={buttonStyle}>
                取消
              </button>
            </>
          )}
        </span>
      </div>

      {/* Name and meta get their own row: one line each, truncated, so a long
          title never pushes the key or the buttons around. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "0 10px 8px",
          borderBottom: `1px solid ${line}`,
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <span
          title={data.name}
          style={{
            fontSize: 12,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {data.name || "（无名称）"}
        </span>
        <span
          style={{
            marginLeft: "auto",
            flexShrink: 0,
            fontSize: 11,
            color: muted,
            whiteSpace: "nowrap",
          }}
        >
          {data.typeLabel || data.type} · {data.state} · r{data.revision}
        </span>
      </div>

      {saveError && (
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
          <div>{conflict ? "已被他人修改，你看到的是旧版本。" : "保存失败："}</div>
          {!conflict && <div style={{ marginTop: 2 }}>{saveError}</div>}
          {conflict && (
            <button
              type="button"
              onClick={() => void reload()}
              disabled={saving}
              style={{ ...buttonStyle, marginTop: 6, borderColor: danger, color: danger }}
            >
              重新载入
            </button>
          )}
          {conflict && (
            <div style={{ marginTop: 6, color: muted }}>
              你的修改还在这里，可以对照后重新保存；不会覆盖别人的改动。
            </div>
          )}
        </div>
      )}

      {/* Two views of one entity. The relations tab exists because "what is
          this connected to" is a question about the entity, not a separate
          page — and it keeps the fields from being buried under a list. */}
      <div
        role="tablist"
        aria-label="实体视图"
        style={{
          display: "flex",
          gap: 2,
          padding: "0 10px",
          borderBottom: `1px solid ${line}`,
          flexShrink: 0,
        }}
      >
        {([
          ["attr", "属性"],
          ["relations", relationCount > 0 ? `关系 ${relationCount}` : "关系"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            style={{
              border: "none",
              borderBottom: `2px solid ${tab === id ? accent : "transparent"}`,
              background: "none",
              color: tab === id ? "inherit" : muted,
              font: "inherit",
              fontSize: 12,
              fontWeight: tab === id ? 600 : 400,
              padding: "6px 10px 5px",
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "attr" && (
      <>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 10px 12px" }}>
        {visible.map((property) => {
          const name = propertyName(property);
          const value = data.fields[name];
          const empty = value === undefined || value === "";
          const description = typeof property.description === "string" ? property.description : "";
          const editable = editing && writable.has(name);

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
                {editing && !writable.has(name) && (
                  <span style={{ display: "block", fontSize: 11, color: muted }}>只读</span>
                )}
              </div>
              <div style={{ minWidth: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: empty ? muted : undefined }}>
                {!editable ? (
                  empty ? "—" : formatValue(value)
                ) : (
                  <FieldControl
                    property={property}
                    value={draft[name] ?? ""}
                    onChange={(next) => setDraft((current) => ({ ...current, [name]: next }))}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>


      {/* Transitions live here, not in the conversation: a reader who is
          looking at the entity is the one who moves it (`FM-SUBMIT` ①). */}
      {!editing && data.routes.length > 0 && (
        <div
          style={{
            flexShrink: 0,
            padding: "8px 10px",
            borderTop: `1px solid ${line}`,
            background: surface,
          }}
        >
          <div style={{ fontSize: 11, color: muted, marginBottom: 6 }}>
            {pendingRoute ? `${pendingRoute.name} → ${pendingRoute.to}：先补齐必填` : `改状态（当前 ${data.state}）`}
          </div>

          {!pendingRoute ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {data.routes.map((route) => {
                const missing = missingFor(route);
                return (
                  <button
                    key={`${route.name}:${route.to}`}
                    type="button"
                    onClick={() => beginRoute(route)}
                    disabled={saving}
                    style={{ ...buttonStyle, opacity: saving ? 0.6 : 1 }}
                    title={
                      missing.length > 0
                        ? `${route.name} → ${route.to}，需先填写：${missing.join("、")}`
                        : `${route.name} → ${route.to}`
                    }
                  >
                    {route.name} → {route.to}
                    {missing.length > 0 && <span style={{ color: muted }}>（需 {missing.length} 项）</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <div>
              {missingFor(pendingRoute).map((name) => {
                const property = properties.find((item) => propertyName(item) === name);
                const values = Array.isArray(property?.validValues)
                  ? property.validValues.filter((item): item is string => typeof item === "string")
                  : [];
                const type = propertyType(property ?? {});
                return (
                  <label key={name} style={{ display: "block", marginBottom: 6, fontSize: 12 }}>
                    <span style={{ display: "block", color: muted, marginBottom: 2 }}>{propertyLabel(property ?? { name })}</span>
                    {values.length > 0 ? (
                      <select
                        value={routeDraft[name] ?? ""}
                        onChange={(event) => setRouteDraft((current) => ({ ...current, [name]: event.target.value }))}
                        style={inputStyle}
                      >
                        <option value="">（未填）</option>
                        {values.map((option) => (
                          <option key={option} value={option}>{option}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={type === "number" ? "number" : type === "date" ? "date" : "text"}
                        value={routeDraft[name] ?? ""}
                        onChange={(event) => setRouteDraft((current) => ({ ...current, [name]: event.target.value }))}
                        style={inputStyle}
                      />
                    )}
                  </label>
                );
              })}

              {routeError && (
                <div role="alert" style={{ color: danger, fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap" }}>
                  {routeError}
                </div>
              )}

              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <button
                  type="button"
                  onClick={() => {
                    const values: Record<string, unknown> = {};
                    for (const name of missingFor(pendingRoute)) values[name] = coerce(name, routeDraft[name] ?? "");
                    void submitRoute(pendingRoute, values);
                  }}
                  disabled={saving}
                  style={{ ...buttonStyle, borderColor: accent, color: accent, opacity: saving ? 0.6 : 1 }}
                >
                  {saving ? "提交中…" : "确认推进"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPendingRoute(null);
                    setRouteDraft({});
                    setRouteError(null);
                  }}
                  disabled={saving}
                  style={buttonStyle}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {/* A transition that needed nothing is submitted straight away, so its
              failure has to be shown here rather than inside the form above —
              otherwise the button just looks dead. */}
          {!pendingRoute && routeError && (
            <div
              role="alert"
              style={{ color: danger, fontSize: 12, marginTop: 6, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              {routeError}
            </div>
          )}
        </div>
      )}

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
        {hidden.size > 0 && (
          <div style={{ color: danger }}>
            {hidden.size} 个字段你无权查看：{[...hidden].join("、")}
          </div>
        )}
        {unfilled.length > 0 && <div>{unfilled.length} 个字段未填写</div>}
        {hidden.size === 0 && unfilled.length === 0 && <div>字段已全部填写</div>}
        {!canEdit && <div>当前状态下你无权修改这条实体</div>}
      </div>
      </>
      )}
      {tab === "relations" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 10px 12px" }}>
          {traceError ? (
            <div style={{ color: danger, fontSize: 12 }}>关系读取失败：{traceError}</div>
          ) : relationGroups.length === 0 ? (
            <div style={{ color: muted, fontSize: 12, padding: "4px 0" }}>
              这条实体还没有建立关联。
            </div>
          ) : (
            relationGroups.map((group) => (
              <div key={`${group.direction}:${group.linkType}`} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: muted, margin: "2px 0 3px" }}>
                  {group.direction === "upstream" ? "上游" : "下游"} · {group.linkType}（{group.rows.length}）
                </div>
                {group.rows.map((row) => (
                  <button
                    key={`${group.direction}:${group.linkType}:${row.key}`}
                    type="button"
                    onClick={() => onOpenEntity?.({ server: data.server, workspace: data.workspace, key: row.key })}
                    disabled={!onOpenEntity}
                    title={`${row.key} ${row.name}`}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 6,
                      width: "100%",
                      padding: "3px 4px",
                      border: "none",
                      background: "none",
                      color: "inherit",
                      font: "inherit",
                      fontSize: 12,
                      textAlign: "left",
                      cursor: onOpenEntity ? "pointer" : "default",
                    }}
                  >
                    <span style={{ flexShrink: 0, color: accent }}>{row.key}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: muted }}>
                      {row.name}
                    </span>
                    <span style={{ flexShrink: 0, fontSize: 11, color: muted }}>{row.state}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
