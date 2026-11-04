"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getProjectDisplayName } from "@/lib/project-display";

type SubscriptionAction = "notify" | "new-task";
type ConnectionState = "connecting" | "live" | "retrying" | "stopped";

interface SourceStatus {
  name: string;
  url: string;
  types: string[];
  entityTypes: string[];
  workspaceId: string | null;
  action: SubscriptionAction;
  filter: string;
  filterError: string | null;
  connection: ConnectionState;
  lastEventAt: string | null;
  lastError: string | null;
  eventCount: number;
  taskRunning: boolean;
  lastTaskAt: string | null;
  lastTaskSessionId: string | null;
  lastTaskError: string | null;
  skippedTasks: number;
}

interface EventRecord {
  seq: number;
  receivedAt: string;
  cwd: string;
  source: string;
  eventType: string;
  entityType: string | null;
  workspaceId: string | null;
  state: string | null;
  key: string | null;
  action: SubscriptionAction;
  eventId: string | null;
  data: unknown;
}

interface Snapshot {
  cwd: string;
  configPath: string;
  configExists: boolean;
  configError: string | null;
  sources: SourceStatus[];
  events: EventRecord[];
}

const EVENT_LIMIT = 300;
const REFRESH_MS = 10_000;

function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour12: false });
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.length <= 3 ? path : `…/${parts.slice(-2).join("/")}`;
}

/**
 * Subscriptions: a list of the events recorded for the current workspace.
 *
 * The sources come from `<workspace>/subscriptions.yaml` — there is no form
 * here on purpose, so there is exactly one place a subscription can be defined.
 * Collection runs in the server process (`lib/subscriptions/runner.ts`), so
 * closing this page does not stop it, and the rows survive a restart because
 * they are appended to a JSONL log.
 */
export function SubscriptionsView({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Showing the events is what clears the sidebar dot. Batched: a burst of
  // events should not produce one request per event.
  const markSeen = useCallback(() => {
    if (!cwd) return;
    void fetch("/api/subscriptions/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    }).catch(() => {
      // The dot stays lit; the next snapshot poll retries nothing destructive.
    });
  }, [cwd]);

  const load = useCallback(async () => {
    if (!cwd) {
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`/api/subscriptions?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const body = await response.json().catch(() => null) as Snapshot | { error?: string } | null;
      if (!response.ok) {
        throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${response.status}`);
      }
      if (!mountedRef.current) return;
      setSnapshot(body as Snapshot);
      setError(null);
      markSeen();
    } catch (loadError) {
      if (mountedRef.current) {
        setError(t("subscriptions.loadFailed", { error: loadError instanceof Error ? loadError.message : String(loadError) }));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [cwd, markSeen, t]);

  useEffect(() => {
    void load();
    if (!cwd) return;
    // Connection state and other sources' events only move on the server, so the
    // snapshot is re-read on a slow timer; new rows still arrive instantly.
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [cwd, load]);

  useEffect(() => {
    if (!cwd) return;
    const source = new EventSource(`/api/subscriptions/events/stream?cwd=${encodeURIComponent(cwd)}`);
    let seenTimer: ReturnType<typeof setTimeout> | null = null;
    source.onmessage = (message) => {
      let record: EventRecord;
      try {
        record = JSON.parse(message.data) as EventRecord;
      } catch {
        return;
      }
      setSnapshot((previous) => {
        if (!previous) return previous;
        if (previous.events.some((event) => event.seq === record.seq)) return previous;
        return { ...previous, events: [...previous.events, record].slice(-EVENT_LIMIT) };
      });
      if (seenTimer) clearTimeout(seenTimer);
      seenTimer = setTimeout(() => markSeen(), 1_000);
    };
    return () => {
      if (seenTimer) clearTimeout(seenTimer);
      source.close();
    };
  }, [cwd, markSeen]);

  const events = useMemo(() => [...(snapshot?.events ?? [])].reverse(), [snapshot?.events]);
  const sources = snapshot?.sources ?? [];
  const filterErrors = sources.filter((source) => source.filterError);
  // Every row in this page belongs to the workspace whose file declared the
  // source, so the project label is the same for all of them.
  const projectLabel = cwd ? getProjectDisplayName(cwd, [cwd]) : "";

  if (!cwd) {
    return (
      <section className="scheduled-view" tabIndex={-1} aria-label={t("subscriptions.title")}>
        <div className="scheduled-shell">
          <header className="scheduled-header">
            <div>
              <h2 className="scheduled-title">{t("subscriptions.title")}</h2>
              <p className="scheduled-subtitle">{t("subscriptions.pickWorkspace")}</p>
            </div>
          </header>
        </div>
      </section>
    );
  }

  return (
    <section
      className="scheduled-view"
      tabIndex={-1}
      aria-label={t("subscriptions.title")}
      // Esc must not reach the global shortcut that stops the agent behind this page.
      onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }}
    >
      <div className="scheduled-shell">
        <header className="scheduled-header">
          <div>
            <h2 className="scheduled-title">{t("subscriptions.title")}</h2>
            <p className="scheduled-subtitle">
              {snapshot?.configPath
                ? t("subscriptions.subtitleWithPath", { path: shortPath(snapshot.configPath) })
                : t("subscriptions.subtitle")}
            </p>
          </div>
          <span className="scheduled-hint">{t("subscriptions.count", { count: events.length })}</span>
        </header>

        {error && <p className="scheduled-error" role="alert">{error}</p>}
        {snapshot?.configError && <p className="scheduled-error" role="alert">{snapshot.configError}</p>}
        {loading && !snapshot && <p className="scheduled-hint">{t("subscriptions.loading")}</p>}

        {snapshot && !snapshot.configExists && (
          <div className="scheduled-empty">
            <h3>{t("subscriptions.noConfigTitle")}</h3>
            <p>{t("subscriptions.noConfigBody", { path: snapshot.configPath })}</p>
          </div>
        )}

        {sources.length > 0 && (
          <ul className="subscriptions-sources">
            {sources.map((source) => (
              <li
                key={source.name}
                className="subscriptions-source"
                title={[
                  source.lastError,
                  source.skippedTasks > 0 ? t("subscriptions.task.skipped", { count: source.skippedTasks }) : null,
                  source.url,
                ].filter(Boolean).join("\n")}
              >
                <span className={`subscriptions-dot subscriptions-dot--${source.connection}`} aria-hidden="true" />
                <span className="subscriptions-source-name">{source.name}</span>
                <span className="subscriptions-source-meta">
                  {[source.entityTypes.join(","), source.workspaceId].filter(Boolean).join(" · ") || source.url}
                </span>
                <span>{t(`subscriptions.connection.${source.connection}`)}</span>
                {source.taskRunning && (
                  <span className="subscriptions-badge subscriptions-badge--task">{t("subscriptions.task.running")}</span>
                )}
                {source.lastTaskError && (
                  <span className="subscriptions-source-meta">{t("subscriptions.task.failed", { error: source.lastTaskError })}</span>
                )}
                {source.lastError && <span className="subscriptions-source-meta">{source.lastError}</span>}
              </li>
            ))}
          </ul>
        )}

        {filterErrors.length > 0 && (
          <p className="scheduled-error" role="alert">
            {filterErrors
              .map((source) => t("subscriptions.filterError", { name: source.name, error: source.filterError ?? "" }))
              .join(" · ")}
          </p>
        )}

        {events.length === 0 ? (
          <div className="scheduled-empty">
            <h3>{t("subscriptions.emptyTitle")}</h3>
            <p>{t("subscriptions.emptyBody")}</p>
          </div>
        ) : (
          <div className="subscriptions-table" role="table" aria-label={t("subscriptions.title")}>
            <div className="subscriptions-row subscriptions-head" role="row">
              <span role="columnheader">{t("subscriptions.col.time")}</span>
              <span role="columnheader" className="subscriptions-col-optional">{t("subscriptions.col.project")}</span>
              <span role="columnheader" className="subscriptions-col-optional subscriptions-col-source">{t("subscriptions.col.source")}</span>
              <span role="columnheader">{t("subscriptions.col.eventType")}</span>
              <span role="columnheader">{t("subscriptions.col.key")}</span>
              <span role="columnheader">{t("subscriptions.col.entityType")}</span>
              <span role="columnheader" className="subscriptions-col-optional">{t("subscriptions.col.workspace")}</span>
              <span role="columnheader">{t("subscriptions.col.state")}</span>
              <span role="columnheader" className="subscriptions-col-optional">{t("subscriptions.col.action")}</span>
            </div>
            {events.map((event) => (
              <div key={event.seq} className="subscriptions-row" role="row">
                <span className="subscriptions-time" role="cell" title={event.receivedAt}>{formatClock(event.receivedAt)}</span>
                <span className="subscriptions-col-optional" role="cell">{projectLabel}</span>
                <span className="subscriptions-col-optional subscriptions-col-source" role="cell">{event.source}</span>
                <span className="subscriptions-type" role="cell" title={event.eventId ?? undefined}>{event.eventType}</span>
                <span className="subscriptions-type" role="cell">{event.key ?? "—"}</span>
                <span role="cell">{event.entityType ?? "—"}</span>
                <span className="subscriptions-col-optional subscriptions-type" role="cell">{event.workspaceId ?? "—"}</span>
                <span role="cell">{event.state ?? "—"}</span>
                <span className="subscriptions-col-optional" role="cell">
                  <span className={`subscriptions-badge${event.action === "new-task" ? " subscriptions-badge--task" : ""}`}>
                    {event.action === "new-task" ? t("subscriptions.action.newTask") : t("subscriptions.action.notify")}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
