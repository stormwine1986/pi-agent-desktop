import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getSubscriptionRuntimeSnapshot } from "@/lib/events/runtime";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
//
// `runningSessionIds` keeps its meaning (a session currently working). The event
// subscriptions add two fields beside it rather than a second channel: which
// sessions asked to be woken, and whether that is working (SSR-000097).
export async function GET() {
  const subscriptions = getSubscriptionRuntimeSnapshot();
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: getRunningRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      subscribedSessionIds: subscriptions.subscribedSessionIds,
      subscriptionHealth: subscriptions.subscriptionHealth,
      // `action: notify` receipts: the sidebar shows the same unread dot a
      // completed background run gets, and raises one system notification.
      subscriptionNotifications: subscriptions.notifications,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
