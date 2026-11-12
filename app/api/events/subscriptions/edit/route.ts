import { NextResponse } from "next/server";
import { isCwdAllowed } from "@/lib/file-access";
import { MATCH_KEYS, type SubscriptionMatch } from "@/lib/events/config";
import { readPanelPatch, saveSubscriptionPatch } from "@/lib/events/edit";
import { ruleRuntimeStatus } from "@/lib/events/runtime";

export const dynamic = "force-dynamic";

/**
 * Writes one change to `.pi/events.yaml` from the panel (`TASK-000149` AC-3).
 *
 * Two rules, both load-bearing:
 *
 * - **the closed-set validator decides.** The candidate text is run through
 *   `parseEventsText()` — the same function `/api/events/subscriptions` and the
 *   loader use — and a broken candidate is refused with that function's exact
 *   message (M2's wording) plus the line it names. The panel never invents a
 *   second vocabulary for "that value is wrong".
 * - **a refused edit writes nothing.** The file is the project's intent and is
 *   in git; a half-applied patch would be worse than the bad value it replaced.
 *
 * The edit itself is surgical (`lib/events/edit.ts`): only the lines of the
 * changed keys are rewritten, so comments and formatting elsewhere survive.
 */

interface Body {
  cwd?: unknown;
  sessionId?: unknown;
  name?: unknown;
  patch?: unknown;
}

function badRequest(error: string, line: number | null = null): Response {
  return NextResponse.json({ ok: false, error, line }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest("请求体必须是 JSON");
  }
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const name = typeof body.name === "string" ? body.name : "";
  if (!cwd) return badRequest("cwd is required");
  if (!sessionId) return badRequest("sessionId is required");
  if (!name) return badRequest("name is required");
  // Same boundary as every other project-file route: a path outside the
  // allowed roots may not be written to, even through the panel.
  if (!(await isCwdAllowed(cwd))) return NextResponse.json({ ok: false, error: "该目录不在可访问范围内" }, { status: 403 });

  const read = readPanelPatch(body.patch);
  if ("error" in read) return badRequest(read.error);

  const outcome = saveSubscriptionPatch(cwd, { sessionId, name }, read.patch);
  if (!outcome.ok) {
    return NextResponse.json(
      { ok: false, path: outcome.path, error: outcome.error, line: outcome.line },
      { status: 400 },
    );
  }

  // Behaviour has to change as fast as the status API: the file is re-read on
  // every scan, but the next scan is up to 15s away, and a person who just
  // pressed 保存 should not have to wonder whether it took.
  const { scanEventRuntimeNow } = await import("@/lib/events/runtime");
  void scanEventRuntimeNow().catch(() => undefined);

  const subscription = outcome.subscription!;
  const status = ruleRuntimeStatus(sessionId, subscription);
  return NextResponse.json({
    ok: true,
    path: outcome.path,
    changed: outcome.changed,
    line: outcome.lines,
    subscription: {
      id: subscription.id,
      name: subscription.name,
      action: subscription.action,
      coalesceSec: subscription.coalesceSec,
      match: subscription.match as SubscriptionMatch,
      matchKeys: MATCH_KEYS,
    },
    runtime: {
      pendingCount: status.pendingCount,
      lastWakeAt: status.lastWakeAt,
      blockedReason: status.blockedReason,
    },
  });
}

/** `applySubscriptionPatch` is used by the dry run too; it is exported from `lib/events/edit.ts`. */
