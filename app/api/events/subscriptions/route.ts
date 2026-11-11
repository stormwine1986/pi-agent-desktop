import { NextResponse } from "next/server";
import { readEventsConfig } from "@/lib/events/config";
import {
  getEventRuntimeStatus,
  ruleRuntimeStatus,
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
  health: SubscriptionHealth;
  /** Why it is not firing, in words the panel can print. */
  reason: string | null;
  lastWakeAt: number | null;
  todayCount: number;
  totalDeliveries: number;
  lastReason: string | null;
  connection: {
    status: string;
    attempt: number;
    lastError: string | null;
    gapAt: number | null;
  } | null;
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
        subscriptions.push({
          id: entry.subscription.id,
          name: entry.subscription.name,
          server: entry.subscription.server,
          workspace: entry.subscription.workspace,
          action: entry.subscription.action,
          health: subscriptionHealthOf(status, exists !== false),
          reason: status.blockedReason,
          lastWakeAt: status.lastWakeAt,
          todayCount: status.todayCount,
          totalDeliveries: status.totalDeliveries,
          lastReason: status.lastReason,
          connection: status.connection,
        });
      }
      const verdict = sessionSubscriptionHealth(session.sessionId, usable);
      return {
        sessionId: session.sessionId,
        title: session.title,
        exists: sessionExistence(session.sessionId),
        error: session.error,
        health: verdict.health,
        reason: verdict.reason,
        subscriptions,
      };
    }),
  };
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}
