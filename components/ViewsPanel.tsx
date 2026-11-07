"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { subscribeEntityWrites } from "@/lib/entity-activity";
import { APP_PREF_KEYS, getPrefJson, setPrefJson } from "@/lib/app-prefs";
import { groupViews, type ViewGroupDecl } from "@/lib/views/group";

/**
 * The to-do views declared by the workspace's `.pi/views.yaml`.
 *
 * A workspace can declare a dozen views, so the panel shows one at a time with
 * a list of titles on the left.
 *
 * **Updates.** A view is a query result, so the panel re-evaluates on three
 * occasions, and they differ in what the user is expected to notice
 * (SSR-000074):
 *
 * - a write this app just made (the assistant pushed a state) → re-evaluate and
 *   apply at once; the row that no longer matches is gone, which is the point;
 * - the 60s poll → compare with the applied result and, if entries are *new*,
 *   hold them and mark the view in the list; the table the user is reading is
 *   not swapped under them;
 * - the refresh button → fetch and apply.
 *
 * The first evaluation of a view establishes the baseline and never reminds.
 * A failed re-evaluation keeps the last known rows and says how old they are
 * rather than pretending to be current.
 *
 * Every view also carries its own error: a broken DQL, an unreachable server
 * and an invalid entry must not blank the panel, and must not be shown as an
 * empty table either — "no rows" has to mean "no rows", never "something
 * failed". A broken view keeps its slot in the list so the user can find out
 * which entry is wrong.
 */
interface ViewRows {
  title: string;
  server: string;
  workspace: string;
  columns: string[];
  rows: string[][];
  entities: { key: string; name: string; state: string }[];
  /** `notify: false` in views.yaml: new entries appear, but nothing is announced. */
  notify: boolean;
  /** Navigation group, or null when the view is ungrouped. */
  group: string | null;
  error: string | null;
}

interface ViewsResponse {
  path: string;
  exists: boolean;
  error: string | null;
  views: ViewRows[];
  /** Declared group order and default folding; empty when none are declared. */
  groups: ViewGroupDecl[];
}

const muted = "rgba(128,128,128,0.75)";
const line = "rgba(128,128,128,0.25)";
const surface = "rgba(128,128,128,0.06)";
const danger = "#e5484d";

const NAV_WIDTH = 180;
const POLL_INTERVAL_MS = 60_000;

/** How many keys a view gained since the copy the user is looking at. */
function countNewKeys(before: ViewRows | undefined, view: ViewRows): number {
  if (!before || before.title !== view.title) return 0;
  const seen = new Set(before.entities.map((entity) => entity.key));
  return view.entities.filter((entity) => entity.key && !seen.has(entity.key)).length;
}

function clockOf(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function ViewsPanel({ cwd, onBringToChat, onOpenEntity, onCreateEntity }: {
  cwd: string;
  /** Hand one row's entity to the conversation composer. */
  onBringToChat?: (ref: { server: string; workspace: string; key: string; name: string; state: string }) => void;
  /** Open one row's entity in its own panel tab. */
  onOpenEntity?: (ref: { server: string; workspace: string; key: string; name: string }) => void;
  /** Start a new entity in this list's channel and space. */
  onCreateEntity?: (ref: { server: string; workspace: string }) => void;
}) {
  const [data, setData] = useState<ViewsResponse | null>(null);
  /** Fetched, but withheld because it contains entries the user has not seen yet. */
  const [held, setHeld] = useState<{ response: ViewsResponse; counts: Record<number, number> } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** When the last successful evaluation happened, if the latest one failed. */
  const [staleAt, setStaleAt] = useState<number | null>(null);
  // Index, not title: two views may share a title, and the file order is what
  // the user sees. Clamped below so a shorter file after an edit stays valid.
  const [selected, setSelected] = useState(0);

  const dataRef = useRef<ViewsResponse | null>(null);
  const inFlightRef = useRef(false);

  const request = useCallback(async (): Promise<ViewsResponse | null> => {
    try {
      const response = await fetch(`/api/views?cwd=${encodeURIComponent(cwd)}`);
      const body = (await response.json().catch(() => null)) as ViewsResponse | { error?: string } | null;
      if (!response.ok) {
        setFailure(((body as { error?: string } | null)?.error) ?? `HTTP ${response.status}`);
        // Only rows we actually had can be "possibly out of date"; a first load
        // that fails has nothing to be stale.
        if (dataRef.current) setStaleAt((previous) => previous ?? Date.now());
        return null;
      }
      return body as ViewsResponse;
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      if (dataRef.current) setStaleAt((previous) => previous ?? Date.now());
      return null;
    }
  }, [cwd]);

  const apply = useCallback((next: ViewsResponse) => {
    dataRef.current = next;
    setData(next);
    setHeld(null);
    setStaleAt(null);
    setFailure(null);
  }, []);

  /**
   * `diff` is the poll: entries that appeared while the user was reading are
   * held back. Everything else is applied, because a value that changed or a
   * row that left the view is not a reminder — it is just the current truth.
   */
  const evaluate = useCallback(async (mode: "apply" | "diff") => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const next = await request();
      if (!next) return;
      const previous = dataRef.current;
      if (mode === "diff" && previous) {
        // A view with `notify: false` never announces: its new rows are applied
        // straight away, so they are visible in the list even while a view that
        // does announce is still holding its own back.
        const counts: Record<number, number> = {};
        const merged: ViewsResponse = {
          ...next,
          views: next.views.map((view, index) => {
            const before = previous.views[index];
            const gained = countNewKeys(before, view);
            if (gained > 0 && view.notify) {
              counts[index] = gained;
              return before ?? view;
            }
            return view;
          }),
        };
        if (Object.keys(counts).length > 0) {
          setHeld({ response: next, counts });
          dataRef.current = merged;
          setData(merged);
          setStaleAt(null);
          setFailure(null);
          return;
        }
        apply(next);
        return;
      }
      apply(next);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, [apply, request]);

  useEffect(() => {
    dataRef.current = null;
    setHeld(null);
    setStaleAt(null);
    void evaluate("apply");
  }, [evaluate]);

  // 60s poll, paused while the panel is not visible. Coming back to the window
  // evaluates immediately: the user is looking again, so stale rows matter.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void evaluate("diff");
    };
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void evaluate("diff");
    };
    document.addEventListener("visibilitychange", onVisible);
  
  return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [evaluate]);

  // A write made by the assistant in this app, to a server one of the views
  // reads: re-evaluate and apply — the change is already visible in the
  // conversation, so the list has to catch up rather than announce itself.
  useEffect(() => subscribeEntityWrites((server) => {
    const views = dataRef.current?.views ?? [];
    // Before the first result there is no view to match against; that first
    // evaluation will read the write anyway.
    if (views.length && !views.some((view) => view.server === server)) return;
    void evaluate("apply");
  }), [evaluate]);

  // Memoised so the grouping below does not recompute on every render.
  const views = useMemo(() => data?.views ?? [], [data]);
  const activeIndex = views.length === 0 ? -1 : Math.min(Math.max(selected, 0), views.length - 1);
  const active = activeIndex >= 0 ? views[activeIndex] : null;

  const nav = useMemo(() => groupViews(views, data?.groups ?? []), [data?.groups, views]);

  // Folded groups: what this project last chose, else the file's default. A
  // local preference, so it stays out of views.yaml (SSR-000087 ⑦).
  //
  // An empty stored list is a choice, not an absence: without that distinction
  // expanding a `collapsed: true` group would be undone by the next poll.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  useEffect(() => {
    const stored = getPrefJson<Record<string, string[]>>(APP_PREF_KEYS.collapsedViewGroups)?.[cwd];
    const initial = Array.isArray(stored)
      ? new Set(stored.filter((title) => typeof title === "string"))
      : new Set((data?.groups ?? []).filter((group) => group.collapsed).map((group) => group.title));
    setCollapsedGroups(initial);
  }, [cwd, data?.groups]);

  const toggleGroup = useCallback((title: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      const all = getPrefJson<Record<string, string[]>>(APP_PREF_KEYS.collapsedViewGroups) ?? {};
      setPrefJson(APP_PREF_KEYS.collapsedViewGroups, { ...all, [cwd]: [...next] });
      return next;
    });
  }, [cwd]);
  const heldCounts = held?.counts ?? {};

  /**
   * One navigation row. Index-based on purpose: grouping changes which section
   * draws a view, never which view a click selects.
   */
  const renderRow = (index: number, indented: boolean) => {
    const view = views[index];
    if (!view) return null;
    const isActive = index === activeIndex;
    const fresh = heldCounts[index] ?? 0;
    return (
      <button
        key={index}
        type="button"
        onClick={() => {
          setSelected(index);
          // Asking for the view is also asking for what is new in it.
          if (held) apply(held.response);
        }}
        aria-current={isActive ? "true" : undefined}
        title={view.error ? `${view.title}\n${view.error}` : view.title}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: indented ? "5px 8px 5px 18px" : "5px 8px 5px 6px",
          border: "none",
          borderLeft: `2px solid ${isActive ? "var(--accent, #5b9dd9)" : "transparent"}`,
          background: isActive ? surface : "none",
          color: view.error ? danger : "inherit",
          font: "inherit",
          fontSize: 12,
          fontWeight: isActive ? 600 : 400,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {view.title}
        </span>
        {view.error ? (
          <span aria-label="配置有误" style={{ flexShrink: 0, fontSize: 10 }}>
            ●
          </span>
        ) : fresh > 0 ? (
          <span
            title={`${fresh} 条新条目，点开查看`}
            style={{ flexShrink: 0, color: "var(--accent, #5b9dd9)", fontVariantNumeric: "tabular-nums" }}
          >
            +{fresh}
          </span>
        ) : (
          <span style={{ flexShrink: 0, color: muted, fontVariantNumeric: "tabular-nums" }}>
            {view.rows.length}
          </span>
        )}
      </button>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderBottom: `1px solid ${line}`,
          fontSize: 12,
          color: muted,
          flexShrink: 0,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {data?.path ?? ".pi/views.yaml"}
        </span>
        {staleAt !== null && (
          <span style={{ color: danger, whiteSpace: "nowrap" }}>可能不是最新（截至 {clockOf(staleAt)}）</span>
        )}
        {/* Creating needs a channel and a space; the list being looked at
            already names both, so the button asks nothing extra. */}
        <button
          type="button"
          onClick={() => {
            if (!active?.server || !active.workspace) return;
            onCreateEntity?.({ server: active.server, workspace: active.workspace });
          }}
          disabled={!onCreateEntity || !active?.server || !active.workspace}
          title={
            !active
              ? "先选一条视图，才知道建在哪个空间"
              : !active.server || !active.workspace
                ? "这条视图没有声明 server/workspace，无法确定建在哪"
                : `在 ${active.workspace} 新建一条实体`
          }
          style={{
            border: `1px solid ${line}`,
            background: surface,
            color: "inherit",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 12,
            cursor: onCreateEntity && active?.server && active.workspace ? "pointer" : "default",
            opacity: onCreateEntity && active?.server && active.workspace ? 1 : 0.5,
          }}
        >
          新建
        </button>
        <button
          type="button"
          onClick={() => void evaluate("apply")}
          disabled={loading}
          style={{
            border: `1px solid ${line}`,
            background: surface,
            color: "inherit",
            borderRadius: 4,
            padding: "2px 8px",
            fontSize: 12,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {active ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <nav
            aria-label="视图"
            style={{
              width: NAV_WIDTH,
              flexShrink: 0,
              borderRight: `1px solid ${line}`,
              overflowY: "auto",
              overflowX: "hidden",
              padding: "4px 0",
            }}
          >
            {nav.ordered.length === 0
              ? nav.ungrouped.map((index) => renderRow(index, false))
              : (
                <>
                  {nav.ordered.map((title) => {
                    const indices = nav.members.get(title) ?? [];
                    const folded = collapsedGroups.has(title);
                    const broken = indices.some((index) => Boolean(views[index]?.error));
                    // A folded group can hold the view being read; say so rather
                    // than leave the reader wondering why no row is marked.
                    const holdsActive = folded && indices.includes(activeIndex);
                    return (
                      <div key={`group:${title}`}>
                        <button
                          type="button"
                          onClick={() => toggleGroup(title)}
                          aria-expanded={!folded}
                          title={`${title}（${indices.length} 个视图）`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            width: "100%",
                            padding: "5px 8px 5px 6px",
                            border: "none",
                            background: "none",
                            color: "inherit",
                            font: "inherit",
                            fontSize: 12,
                            fontWeight: 600,
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <span aria-hidden="true" style={{ flexShrink: 0, color: muted, fontSize: 10, width: 8 }}>
                            {folded ? "▸" : "▾"}
                          </span>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {title}
                          </span>
                          {holdsActive && (
                            <span aria-label="当前视图在这个组里" style={{ flexShrink: 0, color: "var(--accent, #5b9dd9)", fontSize: 10 }}>
                              ●
                            </span>
                          )}
                          {broken && (
                            <span aria-label="组内有配置错误的视图" style={{ flexShrink: 0, color: danger, fontSize: 10 }}>
                              ●
                            </span>
                          )}
                        </button>
                        {/* Folding hides rows only. Evaluation and reminders keep
                            running for every view in the group (SSR-000087 ②). */}
                        {!folded && indices.map((index) => renderRow(index, true))}
                      </div>
                    );
                  })}
                  {nav.ungrouped.length > 0 && (
                    <>
                      <div style={{ height: 1, background: line, margin: "4px 8px" }} />
                      {nav.ungrouped.map((index) => renderRow(index, false))}
                    </>
                  )}
                </>
              )}
          </nav>

          <div style={{ flex: 1, minWidth: 0, overflow: "auto", padding: "8px 10px 16px" }}>
            {failure && <Notice text={failure} />}
            <header style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6, fontSize: 12 }}>
              <strong style={{ fontWeight: 600 }}>{active.title}</strong>
              {!active.error && (
                <span style={{ color: muted }}>
                  {active.rows.length === 0 ? "无数据" : `${active.rows.length} 条`}
                </span>
              )}
            </header>
            {active.error ? <Notice text={active.error} /> : (
              <ViewTable view={active} onBringToChat={onBringToChat} onOpenEntity={onOpenEntity} />
            )}
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px 16px" }}>
          {failure && <Notice text={failure} />}
          {data && !data.exists && (
            <Notice text={`尚未配置视图：在这个项目里创建 ${data.path}（views: [...]）`} />
          )}
          {data?.error && <Notice text={data.error} />}
          {data?.exists && !data.error && (
            <div style={{ fontSize: 12, color: muted, padding: "4px 2px" }}>这个文件里没有配置任何视图。</div>
          )}
        </div>
      )}
    </div>
  );
}

function ViewTable({ view, onBringToChat, onOpenEntity }: {
  view: ViewRows;
  onBringToChat?: (ref: { server: string; workspace: string; key: string; name: string; state: string }) => void;
  onOpenEntity?: (ref: { server: string; workspace: string; key: string; name: string }) => void;
}) {
  if (view.rows.length === 0) {
    return <div style={{ fontSize: 12, color: muted, padding: "4px 2px" }}>这条查询没有匹配的实体。</div>;
  }
  // The hand-off needs the entity behind the row, which is only meaningful when
  // the server told us its key and the view names the channel it came from.
  const canCarry = Boolean(onBringToChat) && view.entities.some((entity) => entity.key);
  const canOpen = Boolean(onOpenEntity) && view.entities.some((entity) => entity.key);
  const showActions = canCarry;
  // A row opens its entity board by clicking its key, so the key column is the
  // target instead of a per-row "open" button. When the view does not name that
  // column, the cell whose text *is* the key still works (`-1` = no such column).
  const keyColumnIndex = view.columns.findIndex((column) => column.trim().toLowerCase() === "key");
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
        <thead>
          <tr>
            {/* First, not last: the table scrolls sideways in a narrow panel, and an
                action column on the right is only reachable after scrolling past
                every configured column. */}
            {showActions && <th style={{ borderBottom: `1px solid ${line}`, width: "1%" }} aria-label="行操作" />}
            {view.columns.map((column) => (
              <th
                key={column}
                style={{
                  textAlign: "left",
                  fontWeight: 600,
                  color: muted,
                  padding: "4px 8px 4px 0",
                  borderBottom: `1px solid ${line}`,
                  whiteSpace: "nowrap",
                }}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row, rowIndex) => {
            const entity = view.entities[rowIndex];
            const rowServable = Boolean(entity?.key && view.server && view.workspace);
            return (
              <tr key={rowIndex}>
                {showActions && (
                  <td style={{ borderBottom: `1px solid ${line}`, padding: "2px 4px 2px 0", whiteSpace: "nowrap", verticalAlign: "top" }}>
                    {canCarry && rowServable && entity ? (
                      <button
                        type="button"
                        onClick={() => onBringToChat?.({ server: view.server, workspace: view.workspace, ...entity })}
                        title={`带入会话：${entity.key}${entity.name ? ` ${entity.name}` : ""}`}
                        aria-label={`带入会话：${entity.key}`}
                        style={{
                          border: `1px solid ${line}`,
                          background: "none",
                          color: muted,
                          borderRadius: 4,
                          padding: 0,
                          width: 16,
                          height: 16,
                          font: "inherit",
                          fontSize: 11,
                          lineHeight: 1,
                          cursor: "pointer",
                        }}
                      >
                        @
                      </button>
                    ) : null}
                  </td>
                )}
                {row.map((value, columnIndex) => {
                  // The key cell is the row's handle: clicking it opens the
                  // entity board. It stays a button so it is keyboard-reachable
                  // and reads as clickable, without an extra column of buttons.
                  const opensEntity = canOpen && rowServable && entity !== undefined
                    && (columnIndex === keyColumnIndex || (keyColumnIndex < 0 && value === entity.key));
                  return (
                    <td
                      key={columnIndex}
                      style={{
                        padding: "3px 8px 3px 0",
                        borderBottom: `1px solid ${line}`,
                        verticalAlign: "top",
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={opensEntity ? `打开实体看板：${entity?.key}${entity?.name ? ` ${entity.name}` : ""}` : value}
                    >
                      {opensEntity && entity ? (
                        <button
                          type="button"
                          className="views-key-link"
                          onClick={() => onOpenEntity?.({ server: view.server, workspace: view.workspace, key: entity.key, name: entity.name })}
                          aria-label={`打开实体看板：${entity.key}`}
                          style={{
                            border: "none",
                            background: "none",
                            padding: 0,
                            font: "inherit",
                            color: "inherit",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          {value}
                        </button>
                      ) : value}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div
      role="alert"
      style={{
        color: danger,
        background: "rgba(229,72,77,0.08)",
        border: "1px solid rgba(229,72,77,0.3)",
        borderRadius: 6,
        padding: "6px 8px",
        fontSize: 12,
        lineHeight: 1.5,
        marginBottom: 8,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {text}
    </div>
  );
}
