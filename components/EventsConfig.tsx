"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { AppSelect } from "./AppSelect";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailGrid,
  ConfigDetailGridRow,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigNotice,
  ConfigSectionTitle,
} from "./SettingsUi";
import { useI18n } from "@/hooks/useI18n";

/**
 * Settings › Events — the panel for `.pi/events.yaml` (SSR-000097 M3).
 *
 * Three things it does that the file alone cannot:
 *
 * - **edits a rule in place** (`action` / `coalesceSec` / `match`): the server
 *   rewrites only the changed lines of the YAML, validates the candidate with
 *   the loader's own closed-set validator, and refuses — with that exact
 *   sentence plus a line — rather than writing something broken;
 * - **dry runs** a rule against the frames the channel actually carried, so a
 *   miss says *which field* refused it and with what value;
 * - **shows the two things that are otherwise invisible**: a `gap` window the
 *   server could not replay ("this stretch did not wake you"), and the
 *   self-excitation warning for `entity.created`/`entity.updated` + `wake`.
 *
 * Everything the panel prints about runtime state comes from
 * `/api/events/subscriptions`; nothing here invents a count.
 */

interface GapRecord {
  at: number;
  reason: string;
  dropped: number | null;
  from: number | null;
  to: number | null;
  recoveredAt: number | null;
  copy?: string;
}

interface Warning {
  code: string;
  message: string;
}

interface RuleStatus {
  id: string;
  name: string;
  server: string;
  workspace: string;
  action: string;
  coalesceSec: number;
  match: Record<string, string[] | null>;
  filter: { events: string[]; entityTypes: string[] };
  health: "active" | "paused" | "limited" | "unavailable";
  reason: string | null;
  lastWakeAt: number | null;
  todayCount: number;
  hourlyCount: number;
  totalDeliveries: number;
  lastReason: string | null;
  pendingCount: number;
  connection: {
    status: string;
    attempt: number;
    lastError: string | null;
    gapAt: number | null;
    gap: GapRecord | null;
  } | null;
  gap: GapRecord | null;
  warnings: Warning[];
}

interface BrokenRule {
  label: string;
  error: string;
}

interface SessionStatus {
  sessionId: string;
  title: string | null;
  exists: boolean | null;
  error: string | null;
  health: string;
  reason: string | null;
  unread: number;
  gaps?: GapRecord[];
  pending: number;
  pausedReason: string | null;
  subscriptions: (RuleStatus | BrokenRule)[];
}

interface SubscriptionsResponse {
  path: string;
  exists: boolean;
  error: string | null;
  runtime: { started: boolean; lastScanAt: number | null; lastScanError: string | null };
  sessions: SessionStatus[];
}

interface DryRunVerdict {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  key: string | null;
  from: string | null;
  to: string | null;
  timestamp: string;
  catchUp: boolean;
  stage: "filter" | "match" | null;
  reasons: string[];
}

interface DryRunResponse {
  ok: boolean;
  error?: string;
  line?: number | null;
  draft?: boolean;
  summary?: string;
  evaluated?: number;
  hits?: DryRunVerdict[];
  misses?: DryRunVerdict[];
  blockedBy?: string | null;
  delayedBy?: string | null;
}

interface DryRunResult extends DryRunResponse {
  ok: boolean;
  evaluated: number;
  hits: DryRunVerdict[];
  misses: DryRunVerdict[];
}

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 32,
  padding: "0 9px",
  border: "var(--hairline) solid var(--border)",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: "var(--fs-caption)",
  outline: "none",
  fontFamily: "var(--font-mono)",
};

function isRule(entry: RuleStatus | BrokenRule): entry is RuleStatus {
  return (entry as RuleStatus).id !== undefined;
}

function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function clockOf(epochMs: number | null): string {
  if (epochMs === null) return "—";
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function EventsConfig({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<SubscriptionsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cwd) return;
    try {
      const response = await fetch(`/api/events/subscriptions?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const body = (await response.json()) as SubscriptionsResponse & { error?: string };
      if (!response.ok) {
        setLoadError(body.error ?? `HTTP ${response.status}`);
        return;
      }
      setData(body);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);
  // The runtime's connection state moves on its own; the panel is a status view
  // as much as an editor, so it re-reads rather than freezing on the first load.
  useEffect(() => {
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const rules = useMemo(() => {
    const flat: { session: SessionStatus; rule: RuleStatus }[] = [];
    for (const session of data?.sessions ?? []) {
      for (const entry of session.subscriptions) {
        if (isRule(entry)) flat.push({ session, rule: entry });
      }
    }
    return flat;
  }, [data]);

  const selected = rules.find((item) => item.rule.id === selectedId) ?? rules[0] ?? null;
  const broken = (data?.sessions ?? []).flatMap((session) =>
    session.subscriptions.filter((entry): entry is BrokenRule => !isRule(entry)),
  );

  if (!cwd) return <ConfigEmptyState>{t("events.noProject")}</ConfigEmptyState>;

  return (
    <ConfigDetail>
      <ConfigDetailStack>
        <div className="config-detail-header">
          <div className="config-detail-header-info">
            <ConfigDetailTitle>{t("settings.events")}</ConfigDetailTitle>
            <span className="config-detail-subtitle is-mono">{data?.path ?? ".pi/events.yaml"}</span>
          </div>
          <ConfigDetailActions>
            <ConfigButton size="small" onClick={() => void load()}>{t("events.reload")}</ConfigButton>
            <ConfigButton size="small" onClick={onClose}>{t("i18n.close")}</ConfigButton>
          </ConfigDetailActions>
        </div>

        {loadError && <ConfigNotice>{loadError}</ConfigNotice>}
        {data?.error && <ConfigNotice>{data.error}</ConfigNotice>}
        {data && !data.error && !data.exists && <ConfigNotice>{t("events.noFile", { path: data.path })}</ConfigNotice>}
        {data?.runtime.lastScanError && <ConfigNotice>{t("events.scanError", { error: data.runtime.lastScanError })}</ConfigNotice>}
        <p className="config-detail-hint">{t("events.intro")}</p>

        {rules.length === 0 && data?.exists && !data.error && (
          <ConfigEmptyState>{t("events.noRules")}</ConfigEmptyState>
        )}

        {rules.length > 0 && (
          <>
            <div className="config-field" style={{ maxWidth: 460 }}>
              <span className="config-field-label">{t("events.rule")}</span>
              <AppSelect
                aria-label={t("events.rule")}
                value={selected?.rule.id ?? ""}
                onValueChange={(value) => setSelectedId(value)}
                options={rules.map((item) => ({
                  value: item.rule.id,
                  label: `${item.rule.name} · ${item.session.title ?? item.session.sessionId.slice(0, 8)} · ${item.rule.health}`,
                }))}
              />
            </div>

            {selected && (
              <RuleEditor
                // A different rule is a different editor: the key remounts it, so
                // a poll can never overwrite a half-typed draft.
                key={selected.rule.id}
                cwd={cwd}
                sessionId={selected.session.sessionId}
                rule={selected.rule}
                onSaved={() => void load()}
              />
            )}
          </>
        )}

        {broken.length > 0 && (
          <div>
            <ConfigSectionTitle>{t("events.brokenTitle")}</ConfigSectionTitle>
            {(data?.sessions ?? []).map((session) => (
              <div key={session.sessionId}>
                {session.error && <p className="config-detail-grid-value is-error">{session.sessionId}：{session.error}</p>}
                {session.subscriptions.filter((entry): entry is BrokenRule => !isRule(entry)).map((entry) => (
                  <p key={entry.label} className="config-detail-grid-value is-error">
                    {entry.label}：{entry.error}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </ConfigDetailStack>
    </ConfigDetail>
  );
}

/** One rule: its runtime facts, then the three fields the panel may change. */
function RuleEditor({
  cwd,
  sessionId,
  rule,
  onSaved,
}: {
  cwd: string;
  sessionId: string;
  rule: RuleStatus;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [action, setAction] = useState(rule.action);
  const [coalesce, setCoalesce] = useState(String(rule.coalesceSec ?? 30));
  const [from, setFrom] = useState((rule.match?.from ?? []).join(", "));
  const [to, setTo] = useState((rule.match?.to ?? []).join(", "));
  const [busy, setBusy] = useState<"save" | "dry" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<{ error: string; line: number | null } | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);

  const patchOf = () => {
    const match: Record<string, string[]> = {};
    const fromList = splitList(from);
    const toList = splitList(to);
    if (fromList.length > 0) match.from = fromList;
    if (toList.length > 0) match.to = toList;
    return { action, coalesceSec: coalesce.trim(), match };
  };

  const save = async () => {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/events/subscriptions/edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, sessionId, name: rule.name, patch: patchOf() }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        line?: number | null;
        changed?: string[];
        path?: string;
      };
      if (!response.ok || !body.ok) {
        setError({ error: body.error ?? `HTTP ${response.status}`, line: body.line ?? null });
        return;
      }
      setNotice(t("events.saved", { keys: (body.changed ?? []).join(" / ") || "—", path: body.path ?? "" }));
      onSaved();
    } catch (problem) {
      setError({ error: problem instanceof Error ? problem.message : String(problem), line: null });
    } finally {
      setBusy(null);
    }
  };

  const runDry = async () => {
    setBusy("dry");
    setError(null);
    try {
      const response = await fetch("/api/events/subscriptions/dry-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, sessionId, name: rule.name, patch: patchOf() }),
      });
      const body = (await response.json()) as DryRunResponse;
      if (!response.ok || !body.ok) {
        setError({ error: body.error ?? `HTTP ${response.status}`, line: body.line ?? null });
        setDryRun(null);
        return;
      }
      setDryRun(body as DryRunResult);
    } catch (problem) {
      setError({ error: problem instanceof Error ? problem.message : String(problem), line: null });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="events-rule" data-events-rule={rule.id}>
      <ConfigSectionTitle>{rule.name}</ConfigSectionTitle>
      {rule.gap && (
        <ConfigNotice>
          <span data-events-gap={rule.gap.reason}>{rule.gap.copy ?? rule.gap.reason}</span>
        </ConfigNotice>
      )}
      {rule.warnings.map((warning) => (
        <ConfigNotice key={warning.code}>
          <span data-events-warning={warning.code}>{warning.message}</span>
        </ConfigNotice>
      ))}
      <ConfigDetailGrid>
        <ConfigDetailGridRow label={t("events.health")} mono>
          {t(`sidebar.subscriptionHealth.${rule.health}`)}
        </ConfigDetailGridRow>
        <ConfigDetailGridRow label={t("events.server")} mono>
          {rule.server} · {rule.workspace}
        </ConfigDetailGridRow>
        <ConfigDetailGridRow label={t("events.connection")} mono>
          {rule.connection?.status ?? "—"}
          {rule.connection?.attempt ? ` (${rule.connection.attempt})` : ""}
        </ConfigDetailGridRow>
        <ConfigDetailGridRow label={t("events.lastWake")} mono>
          {clockOf(rule.lastWakeAt)}
        </ConfigDetailGridRow>
        <ConfigDetailGridRow label={t("events.counts")} mono>
          {t("events.countsValue", {
            today: rule.todayCount,
            hourly: rule.hourlyCount,
            total: rule.totalDeliveries,
            pending: rule.pendingCount,
          })}
        </ConfigDetailGridRow>
        <ConfigDetailGridRow label={t("events.reason")} tone={rule.reason ? "error" : "muted"}>
          {rule.reason ?? rule.lastReason ?? "—"}
        </ConfigDetailGridRow>
      </ConfigDetailGrid>
      <p className="config-detail-hint">{t("events.editHint")}</p>
      <div
        className="events-editor"
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, alignItems: "end" }}
      >
        <ConfigField label={t("events.action")}>
          <AppSelect
            aria-label={t("events.action")}
            value={action}
            onValueChange={(value) => setAction(value)}
            options={[
              { value: "wake", label: t("events.actionWake") },
              { value: "notify", label: t("events.actionNotify") },
            ]}
          />
        </ConfigField>
        <ConfigField label={t("events.coalesce")}>
          <input
            aria-label={t("events.coalesce")}
            type="number"
            min={1}
            step={1}
            value={coalesce}
            onChange={(event) => setCoalesce(event.target.value)}
            style={inputStyle}
          />
        </ConfigField>
        <ConfigField label={t("events.matchFrom")}>
          <input
            aria-label={t("events.matchFrom")}
            placeholder="OPEN, DRAFT"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            style={inputStyle}
          />
        </ConfigField>
        <ConfigField label={t("events.matchTo")}>
          <input
            aria-label={t("events.matchTo")}
            placeholder="DONE, STUCK"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            style={inputStyle}
          />
        </ConfigField>
      </div>
      <div className="config-detail-actions" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <ConfigButton size="small" variant="primary" onClick={() => void save()} disabled={busy !== null}>
          {busy === "save" ? t("events.saving") : t("events.save")}
        </ConfigButton>
        <ConfigButton size="small" onClick={() => void runDry()} disabled={busy !== null}>
          {busy === "dry" ? t("events.dryRunning") : t("events.dryRun")}
        </ConfigButton>
      </div>
      {error && (
        <p role="alert" className="config-detail-grid-value is-error" style={{ whiteSpace: "pre-wrap" }} data-events-error>
          {error.line ? t("events.refusedAtLine", { line: error.line, error: error.error }) : error.error}
        </p>
      )}
      {notice && <p role="status" className="config-detail-hint">{notice}</p>}
      {dryRun && <DryRunView result={dryRun} />}
    </div>
  );
}

function DryRunView({ result }: { result: DryRunResult }) {
  const { t } = useI18n();
  const rows = [...result.hits, ...result.misses];
  return (
    <div className="events-dry-run" data-events-dry-run style={{ display: "grid", gap: 6 }}>
      <ConfigSectionTitle>{t("events.dryTitle")}</ConfigSectionTitle>
      <p className="config-detail-hint">
        {result.summary ?? t("events.drySummary", {
          evaluated: result.evaluated,
          hits: result.hits.length,
          misses: result.misses.length,
        })}
      </p>
      {result.blockedBy && <p className="config-detail-grid-value is-error">{result.blockedBy}</p>}
      {result.delayedBy && <p className="config-detail-hint">{result.delayedBy}</p>}
      {rows.slice(0, 20).map((row) => (
        <div
          key={`${row.eventId}-${row.stage ?? "hit"}`}
          className="config-detail-grid-value"
          data-events-dry-verdict={row.stage ?? "hit"}
          style={{ display: "grid", gap: 2, borderTop: "var(--hairline) solid var(--border)", paddingTop: 6 }}
        >
          <span className="is-mono">
            {row.stage === null ? "✓" : "✗"} {row.eventType} · {row.aggregateType} {row.key ?? row.aggregateId}
            {row.catchUp ? ` · ${t("events.backfill")}` : ""}
          </span>
          {row.reasons.map((reason, index) => (
            <span key={index} className="config-detail-hint">{reason}</span>
          ))}
        </div>
      ))}
    </div>
  );
}
