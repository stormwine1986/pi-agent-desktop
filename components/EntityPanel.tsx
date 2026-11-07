"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { AppSelect } from "./AppSelect";

import { MAX_LINK_KEYS, parseLinkKeys, type LinkKeyCheck } from "@/lib/entity-links";
import type { LinkOption } from "@/lib/entity-permissions";

import {
  accent,
  buttonStyle,
  danger,
  FieldControl,
  formatValue,
  inputStyle,
  isTableDraft,
  isTableProperty,
  line,
  muted,
  propertyLabel,
  propertyName,
  propertyType,
  serializeTableRows,
  surface,
  TableEditor,
  tableDraftRows,
  TableValue,
  type DraftMap,
  type FieldDraft,
  type FieldProperty,
} from "./entity-field";

/** The shape `GET /api/entity` answers (kept in step with `app/api/entity/route.ts`). */
interface RelationRow {
  key: string;
  type: string;
  name: string;
  state: string;
  linkType: string;
  /** The relation named from this entity's side; used when reading downstream. */
  inverseLinkType: string;
  direction: "upstream" | "downstream";
  /** Whether this reader may remove the link — decided by the side that owns it. */
  canUnlink: boolean;
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
  /** Relations this type declares, with this reader's right to create each. */
  linkOptions: LinkOption[];
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

/**
 * A draft starts from what the server holds: text for most fields, rows for a
 * `table` field (a table is edited row by row, never as a JSON blob).
 */
function draftOf(data: EntityResponse): DraftMap {
  const draft: DraftMap = {};
  for (const property of data.properties) {
    const name = propertyName(property);
    if (!name) continue;
    const value = data.fields[name];
    if (isTableProperty(property)) {
      draft[name] = tableDraftRows(property, value);
      continue;
    }
    draft[name] = value === undefined || value === null ? "" : formatValue(value);
  }
  return draft;
}

/** Same text/rows comparison for both shapes, so a save sends only what changed. */
function sameDraft(before: FieldDraft | undefined, after: FieldDraft | undefined): boolean {
  return JSON.stringify(before ?? "") === JSON.stringify(after ?? "");
}

/** Only what changed, so a save cannot touch fields the user never looked at. */
function changedFields(data: EntityResponse, draft: DraftMap): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const property of data.properties) {
    const name = propertyName(property);
    if (!name || !(name in draft)) continue;
    const value = draft[name];
    if (isTableProperty(property)) {
      const rows = isTableDraft(value) ? value : [];
      const beforeRows = tableDraftRows(property, data.fields[name]);
      if (sameDraft(rows, beforeRows)) continue;
      // Rows, not text: the base takes an array of objects here.
      changed[name] = serializeTableRows(property, rows);
      continue;
    }
    const text = typeof value === "string" ? value : "";
    const before = data.fields[name];
    const beforeText = before === undefined || before === null ? "" : formatValue(before);
    if (text === beforeText) continue;
    // Numbers go back as numbers; everything else stays a string and lets the
    // server reject what it does not accept (`FM-VALIDATE`).
    changed[name] = propertyType(property) === "number" && text.trim() !== ""
      ? Number(text)
      : text;
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
  const [draft, setDraft] = useState<DraftMap>({});
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
  // Linking by key: no search here — keys come from the conversation, get
  // judged first, and only what the base would accept goes on to be written.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkType, setLinkType] = useState("");
  const [keyText, setKeyText] = useState("");
  // The text the current verdicts belong to; anything newer is unjudged.
  const [checkedText, setCheckedText] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkItems, setCheckItems] = useState<LinkKeyCheck[]>([]);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  // Which row is asking "really remove this?", keyed by direction:linkType:key.
  const [breakTarget, setBreakTarget] = useState<string | null>(null);
  const [breaking, setBreaking] = useState(false);
  const [breakError, setBreakError] = useState<string | null>(null);

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
   * Relations the type declares come first, even with nothing linked: an entity
   * with no links must still show what it *could* link, otherwise "没挂" and
   * "不能挂" look the same in a panel that has room for neither explanation.
   * The grouping uses the base's own names rather than a table of ours.
   */
  const relationGroups = useMemo(() => {
    interface Group {
      id: string;
      direction: "upstream" | "downstream";
      linkType: string;
      label: string;
      targetTypes: string[];
      rows: RelationRow[];
    }
    const groups = new Map<string, Group>();
    for (const option of data?.linkOptions ?? []) {
      groups.set(`upstream:${option.linkType}`, {
        id: `upstream:${option.linkType}`,
        direction: "upstream",
        linkType: option.linkType,
        label: option.linkType,
        targetTypes: option.targetTypes,
        rows: [],
      });
    }
    const sides: Array<[Group["direction"], RelationRow[]]> = [
      ["upstream", traces?.upstream ?? []],
      ["downstream", traces?.downstream ?? []],
    ];
    for (const [direction, rows] of sides) {
      for (const row of rows) {
        const id = `${direction}:${row.linkType}`;
        const existing = groups.get(id);
        if (existing) {
          existing.rows.push(row);
          continue;
        }
        groups.set(id, {
          id,
          direction,
          linkType: row.linkType,
          // A downstream link is named by the side that owns it; reading it
          // back with the inverse name is what makes "被谁指向" legible.
          label: direction === "downstream" ? row.inverseLinkType || row.linkType : row.linkType,
          targetTypes: [],
          rows: [row],
        });
      }
    }
    return [...groups.values()];
  }, [data, traces]);
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

  const parsedKeys = useMemo(() => parseLinkKeys(keyText), [keyText]);
  const linkOptions = data?.linkOptions ?? [];
  const selectedLink = linkOptions.find((option) => option.linkType === linkType) ?? null;
  const okItems = checkItems.filter((item) => item.ok);
  const rejected = checkItems.length - okItems.length;
  // A verdict belongs to the text it judged: editing after that makes it stale.
  const linkReady = Boolean(
    data && selectedLink?.canLink && okItems.length > 0 && !checking && !linking && keyText === checkedText,
  );

  const openLinkForm = () => {
    setLinkError(null);
    if (linkOpen) {
      setLinkOpen(false);
      return;
    }
    if (!linkType) {
      const first = linkOptions.find((option) => option.canLink) ?? linkOptions[0];
      setLinkType(first?.linkType ?? "");
    }
    setLinkOpen(true);
  };

  /** Judges every key in the box — one request, one verdict per key. */
  const runCheck = useCallback(async () => {
    if (!data || !selectedLink) return;
    const keys = parseLinkKeys(keyText).keys;
    const judged = keyText;
    if (keys.length === 0) {
      setCheckItems([]);
      setCheckedText(judged);
      return;
    }
    setChecking(true);
    setLinkError(null);
    try {
      const params = new URLSearchParams({ cwd: target.cwd, server: data.server });
      const response = await fetch(`/api/entity/link/check?${params}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceKey: data.key, linkType: selectedLink.linkType, keys }),
      });
      const body = await response.json() as { items?: LinkKeyCheck[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setCheckItems(body.items ?? []);
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      // Judged either way: a failed check must not re-fire on every render.
      setCheckedText(judged);
      setChecking(false);
    }
  }, [data, keyText, selectedLink, target.cwd]);

  // Typing pauses → judge. Blur judges at once (see the textarea).
  useEffect(() => {
    if (!linkOpen || checking || keyText === checkedText) return;
    const timer = setTimeout(() => { void runCheck(); }, 400);
    return () => clearTimeout(timer);
  }, [linkOpen, checking, keyText, checkedText, runCheck]);

  const submitLink = async () => {
    if (!data || !selectedLink || !linkReady) return;
    const targetKeys = okItems.map((item) => item.resolvedKey || item.key);
    setLinking(true);
    setLinkError(null);
    try {
      const params = new URLSearchParams({ cwd: target.cwd, server: data.server });
      const response = await fetch(`/api/entity/link?${params}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceKey: data.key, linkType: selectedLink.linkType, targetKeys }),
      });
      const body = await response.json() as { revision?: number; error?: string };
      if (!response.ok) {
        // The batch is atomic: a failure here linked nothing at all.
        setLinkError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      // Only the keys that went through leave the box; the rejected ones stay
      // with their reason, so a typo is never silently swallowed.
      const done = new Set(targetKeys.map((key) => key.toUpperCase()));
      const rest = parseLinkKeys(keyText).keys.filter((key) => !done.has(key.toUpperCase()));
      const restText = rest.join(" ");
      setKeyText(restText);
      setCheckedText(restText);
      setCheckItems((current) => current.filter((item) => !item.ok));
      if (rest.length === 0) setLinkOpen(false);
      if (typeof body.revision === "number") {
        // A new revision also re-reads the traces, so the list shows the link.
        const revision = body.revision;
        setData((current) => (current ? { ...current, revision } : current));
      }
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLinking(false);
    }
  };

  const removeKey = (key: string) => {
    const id = key.toUpperCase();
    const rest = parseLinkKeys(keyText).keys.filter((item) => item.toUpperCase() !== id);
    const restText = rest.join(" ");
    setKeyText(restText);
    setCheckedText(restText);
    setCheckItems((current) => current.filter((item) => item.key.toUpperCase() !== id));
  };

  /**
   * Removes one link. The downstream end is the source, which is the other
   * entity for a downstream row — the call carries both ends explicitly.
   */
  const breakLink = async (row: RelationRow) => {
    if (!data || breaking) return;
    setBreaking(true);
    setBreakError(null);
    try {
      const params = new URLSearchParams({
        cwd: target.cwd,
        server: data.server,
        source: row.direction === "upstream" ? data.key : row.key,
        target: row.direction === "upstream" ? row.key : data.key,
        linkType: row.linkType,
        self: data.key,
      });
      const response = await fetch(`/api/entity/link?${params}`, { method: "DELETE" });
      const body = await response.json() as { revision?: number; error?: string };
      if (!response.ok) {
        setBreakError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      setBreakTarget(null);
      if (typeof body.revision === "number") {
        const revision = body.revision;
        setData((current) => (current ? { ...current, revision } : current));
      }
    } catch (cause) {
      setBreakError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBreaking(false);
    }
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
                  empty
                    ? "—"
                    : isTableProperty(property)
                      ? <TableValue property={property} value={value} />
                      : formatValue(value)
                ) : isTableProperty(property) ? (
                  <TableEditor
                    property={property}
                    rows={isTableDraft(draft[name]) ? draft[name] : []}
                    onChange={(rows) => setDraft((current) => ({ ...current, [name]: rows }))}
                  />
                ) : (
                  <FieldControl
                    property={property}
                    value={typeof draft[name] === "string" ? draft[name] : ""}
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
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px 0", flexShrink: 0 }}>
            <button
              type="button"
              onClick={openLinkForm}
              disabled={linkOptions.length === 0}
              title={linkOptions.length === 0 ? "这个类型没有声明任何关系" : "按 key 挂上游实体"}
              style={{
                ...buttonStyle,
                borderColor: accent,
                color: accent,
                opacity: linkOptions.length === 0 ? 0.5 : 1,
              }}
            >
              {linkOpen ? "收起挂链" : "＋ 挂链"}
            </button>
            <span style={{ marginLeft: "auto", fontSize: 11, color: muted }}>只挂上游</span>
          </div>

          {linkOpen && (
            <div
              style={{
                margin: "8px 10px 0",
                padding: 8,
                border: `1px solid ${line}`,
                borderRadius: 8,
                background: surface,
                flexShrink: 0,
              }}
            >
              <label style={{ display: "block", marginBottom: 6 }}>
                <span style={{ display: "block", fontSize: 11, color: muted, marginBottom: 2 }}>关系</span>
                <AppSelect
                  aria-label="关系"
                  value={selectedLink?.linkType ?? ""}
                  onValueChange={(next) => {
                    setLinkType(next);
                    // Verdicts depend on the relation's target types and states,
                    // so none of them survive a change.
                    setCheckItems([]);
                    setCheckedText("");
                    setLinkError(null);
                  }}
                  style={inputStyle}
                  options={linkOptions.map((option) => ({
                    value: option.linkType,
                    label: `${option.linkType}${option.targetTypes.length > 0 ? ` → ${option.targetTypes.join(" / ")}` : ""}`
                      + (option.canLink ? "" : option.blockedBy === "state" ? "（当前状态不可挂）" : "（无权限）"),
                    disabled: !option.canLink,
                  }))}
                />
              </label>
              {selectedLink?.description && (
                <div style={{ fontSize: 11, color: muted, marginBottom: 6 }}>{selectedLink.description}</div>
              )}

              <span style={{ display: "block", fontSize: 11, color: muted, marginBottom: 2 }}>
                目标 key
                <span style={{ marginLeft: 6, opacity: 0.8 }}>
                  空格 / 逗号 / 换行分隔，最多 {MAX_LINK_KEYS} 个
                </span>
              </span>
              <textarea
                value={keyText}
                onChange={(event) => setKeyText(event.target.value)}
                onBlur={() => {
                  if (keyText !== checkedText) void runCheck();
                }}
                placeholder="MR-000250 MR-000244"
                rows={2}
                spellCheck={false}
                style={{ ...inputStyle, resize: "vertical", lineHeight: 1.6 }}
              />
              {parsedKeys.overflow > 0 && (
                <div style={{ fontSize: 11, color: danger, marginTop: 4 }}>
                  共 {parsedKeys.total} 个，最多 {MAX_LINK_KEYS} 个，先去掉 {parsedKeys.overflow} 个
                </div>
              )}

              {checking && <div style={{ fontSize: 11, color: muted, marginTop: 4 }}>校验中…</div>}

              {checkItems.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {checkItems.map((item) => (
                    <div
                      key={`${item.key}:${item.reason ?? "ok"}`}
                      style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "2px 2px", fontSize: 12 }}
                    >
                      <span style={{ width: 10, flexShrink: 0, color: item.ok ? accent : danger }}>
                        {item.ok ? "✓" : "×"}
                      </span>
                      <span style={{ flexShrink: 0, color: item.ok ? accent : muted }}>
                        {item.resolvedKey || item.key}
                      </span>
                      <span
                        title={item.detail}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: item.ok ? muted : danger,
                        }}
                      >
                        {item.ok ? item.name || "（无名称）" : item.detail}
                      </span>
                      {item.ok && <span style={{ flexShrink: 0, fontSize: 11, color: muted }}>{item.state}</span>}
                      <button
                        type="button"
                        onClick={() => removeKey(item.key)}
                        title={`从输入里去掉 ${item.key}`}
                        style={{
                          border: "none",
                          background: "none",
                          color: muted,
                          font: "inherit",
                          fontSize: 11,
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {linkError && (
                <div
                  role="alert"
                  style={{
                    color: danger,
                    fontSize: 12,
                    marginTop: 6,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {linkError}
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => void submitLink()}
                  disabled={!linkReady}
                  style={{ ...buttonStyle, borderColor: accent, color: accent, opacity: linkReady ? 1 : 0.5 }}
                >
                  {linking ? "挂链中…" : checking ? "校验中…" : okItems.length > 0 ? `挂 ${okItems.length} 条` : "挂链"}
                </button>
                <button type="button" onClick={openLinkForm} disabled={linking} style={buttonStyle}>
                  取消
                </button>
                {rejected > 0 && (
                  <span style={{ marginLeft: "auto", fontSize: 11, color: muted }}>
                    {rejected} 条不可挂，会留在框里
                  </span>
                )}
              </div>
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "4px 10px 12px" }}>
            {traceError ? (
              <div style={{ color: danger, fontSize: 12 }}>关系读取失败：{traceError}</div>
            ) : relationGroups.length === 0 ? (
              <div style={{ color: muted, fontSize: 12, padding: "4px 0" }}>
                这条实体还没有建立关联。
              </div>
            ) : (
              relationGroups.map((group) => (
                <div key={group.id} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: muted, margin: "2px 0 3px" }}>
                    {group.direction === "upstream" ? "上游" : "下游"} · {group.label}
                    {group.targetTypes.length > 0 ? ` → ${group.targetTypes.join(" / ")}` : ""}（{group.rows.length}）
                  </div>
                  {group.rows.length === 0 ? (
                    <div style={{ fontSize: 11, color: muted, padding: "2px 4px" }}>还没有挂</div>
                  ) : (
                    group.rows.map((row) => {
                      const id = `${group.direction}:${group.linkType}:${row.key}`;
                      if (breakTarget === id) {
                        return (
                          <div
                            key={row.key}
                            style={{
                              margin: "2px 0 4px",
                              padding: "4px 6px",
                              border: `1px solid ${danger}`,
                              borderRadius: 6,
                              background: "rgba(229,72,77,0.08)",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: 11 }}>断开 {row.key}？</span>
                              <button
                                type="button"
                                onClick={() => void breakLink(row)}
                                disabled={breaking}
                                style={{
                                  marginLeft: "auto",
                                  ...buttonStyle,
                                  borderColor: danger,
                                  color: danger,
                                  padding: "1px 7px",
                                  fontSize: 11,
                                  opacity: breaking ? 0.6 : 1,
                                }}
                              >
                                {breaking ? "断开中…" : "断开"}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setBreakTarget(null);
                                  setBreakError(null);
                                }}
                                disabled={breaking}
                                style={{ ...buttonStyle, padding: "1px 7px", fontSize: 11 }}
                              >
                                取消
                              </button>
                            </div>
                            {breakError && (
                              <div style={{ color: danger, fontSize: 11, marginTop: 4, whiteSpace: "pre-wrap" }}>
                                {breakError}
                              </div>
                            )}
                          </div>
                        );
                      }
                      return (
                        <div
                          key={row.key}
                          style={{ display: "flex", alignItems: "baseline", gap: 6, padding: "3px 2px" }}
                        >
                          <button
                            type="button"
                            onClick={() => onOpenEntity?.({ server: data.server, workspace: data.workspace, key: row.key })}
                            disabled={!onOpenEntity}
                            title={`${row.key} ${row.name}`}
                            style={{
                              display: "flex",
                              alignItems: "baseline",
                              gap: 6,
                              flex: 1,
                              minWidth: 0,
                              padding: 0,
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
                          {row.canUnlink ? (
                            <button
                              type="button"
                              onClick={() => {
                                setBreakError(null);
                                setBreakTarget(id);
                              }}
                              title={`断开 ${row.key}`}
                              style={{ ...buttonStyle, padding: "1px 7px", fontSize: 11 }}
                            >
                              断开
                            </button>
                          ) : (
                            <span
                              title="这条链接由下游那一端维护，需要对该类型有写权限"
                              style={{ flexShrink: 0, fontSize: 11, color: muted, opacity: 0.8 }}
                            >
                              归对方所有
                            </span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
