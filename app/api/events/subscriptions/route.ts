import { NextResponse } from "next/server";
import { describeGap, type GapNotice } from "@/lib/events/catch-up";
import { readEventsConfig, type SubscriptionMatch } from "@/lib/events/config";
import { selfExcitationWarning, type SubscriptionWarning } from "@/lib/events/dry-run";
import {
  getEventRuntimeStatus,
  ruleRuntimeStatus,
  sessionEventFacts,
  sessionExistence,
  sessionSubscriptionHealth,
  subscriptionHealthOf,
  type SubscriptionHealth,
} from "@/lib/events/runtime";

export const dynamic = "force-dynamic";

/**
 * Status of the event subscriptions declared by `<cwd>/.pi/events.yaml`
 * (SSR-000097【会话列表标记】/ AC-9).
 *
 * Same shape as `/api/views`: the file is the configuration, and every entry
 * reports its own reason. Two rules here:
 *
 * - **the file is read now**, not from a cache, so an edit shows up without a
 *   restart; the runtime only contributes live facts (connection state, last
 *   wake-up, today's count);
 * - **nothing secret leaves this route**: no token, no ticket, no endpoint URL,
 *   only the mcp.json entry name and the workspace id (AC-14).
 */
interface SubscriptionStatus {
  id: string;
  name: string;
  server: string;
  workspace: string;
  action: string;
  /** The editable fields, so the panel can show and prefill them without a second read. */
  coalesceSec: number;
  match: SubscriptionMatch;
  filter: { events: string[]; entityTypes: string[] };
  health: SubscriptionHealth;
  /** Why it is not firing, in words the panel can print. */
  reason: string | null;
  lastWakeAt: number | null;
  todayCount: number;
  /** Delivered in the rolling hour (`maxPerHour` window). */
  hourlyCount: number;
  totalDeliveries: number;
  lastReason: string | null;
  /** Batches parked behind the session's current turn (`pendingBatch`). */
  pendingCount: number;
  connection: {
    status: string;
    attempt: number;
    lastError: string | null;
    gapAt: number | null;
    gap: GapNotice | null;
  } | null;
  /**
   * Which stretch of time the channel could not replay (SSR-000097 M3 / AC-1).
   * `copy` is the sentence the panel prints — a gap is never silent, and a
   * recovered one says it was recovered rather than disappearing.
   */
  gap: (GapNotice & { copy: string }) | null;
  /** Non-blocking configuration warnings (self-excitation, AC-5). */
  warnings: SubscriptionWarning[];
}

interface BrokenSubscription {
  label: string;
  error: string;
}

export async function GET(request: Request): Promise<Response> {
  const cwd = new URL(request.url).searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });

  const config = readEventsConfig(cwd);
  const runtime = getEventRuntimeStatus();
  const response = {
    path: config.path,
    exists: config.exists,
    error: config.error,
    runtime: {
      started: runtime.started,
      lastScanAt: runtime.lastScanAt,
      lastScanError: runtime.lastScanError,
      pending: runtime.pending,
    },
    sessions: config.sessions.map((session) => {
      const subscriptions: (SubscriptionStatus | BrokenSubscription)[] = [];
      const usable = [];
      for (const entry of session.subscriptions) {
        if (!entry.subscription) {
          subscriptions.push({ label: entry.label, error: entry.error ?? "无法使用" });
          continue;
        }
        usable.push(entry.subscription);
        const status = ruleRuntimeStatus(session.sessionId, entry.subscription);
        const exists = sessionExistence(session.sessionId);
        const health = subscriptionHealthOf(status, exists !== false);
        const notice = status.connection?.gap ?? null;
        const warning = selfExcitationWarning(entry.subscription);
        subscriptions.push({
          id: entry.subscription.id,
          name: entry.subscription.name,
          server: entry.subscription.server,
          workspace: entry.subscription.workspace,
          action: entry.subscription.action,
          coalesceSec: entry.subscription.coalesceSec,
          match: entry.subscription.match,
          filter: {
            events: entry.subscription.filter.events,
            entityTypes: entry.subscription.filter.entityTypes,
          },
          health,
          // `limited` has its own reason: the channel is fine, the budget is not.
          reason: health === "limited" ? status.limitedReason : status.blockedReason,
          lastWakeAt: status.lastWakeAt,
          todayCount: status.todayCount,
          hourlyCount: status.hourlyCount,
          totalDeliveries: status.totalDeliveries,
          lastReason: status.lastReason,
          pendingCount: status.pendingCount,
          connection: status.connection,
          gap: notice ? { ...notice, copy: describeGap(notice) } : null,
          warnings: warning ? [warning] : [],
        });
      }
      const verdict = sessionSubscriptionHealth(session.sessionId, usable);
      const facts = sessionEventFacts(session.sessionId);
      // One line per session, even when several rules share a channel: the gap
      // is a fact about the channel, not about each rule that reads it.
      const gaps = subscriptions
        .filter((item): item is SubscriptionStatus => "gap" in item && item.gap !== null)
        .map((item) => item.gap!);
      const latestGap = gaps.length > 0
        ? gaps.reduce((newest, current) => (current.at > newest.at ? current : newest))
        : null;
      return {
        sessionId: session.sessionId,
        title: session.title,
        exists: sessionExistence(session.sessionId),
        error: session.error,
        health: verdict.health,
        reason: verdict.reason,
        /** Unread `action: notify` hits; opened sessions clear it. */
        unread: facts.unread,
        lastNotifyAt: facts.lastNotifyAt,
        lastNotifyText: facts.lastNotifyText,
        /** `gap` windows of every channel this session listens on (newest first). */
        gaps: gaps.sort((left, right) => right.at - left.at),
        gap: latestGap,
        pending: facts.pending,
        pausedReason: facts.pausedReason,
        subscriptions,
      };
    }),
  };
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}
