import { NextResponse } from "next/server";
import { isCwdAllowed } from "@/lib/file-access";
import { readEventsConfig, usableSubscriptions, type EventSubscription } from "@/lib/events/config";
import { describeDryRun, dryRunSubscription } from "@/lib/events/dry-run";
import { draftSubscription, readPanelPatch } from "@/lib/events/edit";
import { desiredChannels, recentEventsOf, ruleRuntimeStatus, sessionEventFacts } from "@/lib/events/runtime";
import { isSessionRunning } from "@/lib/events/delivery";

export const dynamic = "force-dynamic";

/**
 * "Would this rule have fired on what this channel has actually carried?"
 * (`TASK-000149` AC-4).
 *
 * A read: nothing is delivered, no counter moves, no `pendingBatch` appears. The
 * answer comes from the frames the runtime kept in memory (`recentEventsOf`), so
 * it describes the real feed rather than a made-up sample.
 *
 * A draft `patch` is allowed and is *not* written: the candidate file text goes
 * through the same closed-set validator the loader uses, and the rule it
 * describes is the one evaluated. That makes "try the edit before saving it"
 * possible, and it means an illegal value fails here with the same sentence it
 * would fail with on save.
 */

interface Body {
  cwd?: unknown;
  sessionId?: unknown;
  name?: unknown;
  patch?: unknown;
  /** How many recent frames to judge (default 50, at most 200). */
  limit?: unknown;
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
  if (!(await isCwdAllowed(cwd))) return NextResponse.json({ ok: false, error: "该目录不在可访问范围内" }, { status: 403 });

  const read = readPanelPatch(body.patch);
  if ("error" in read) return badRequest(read.error);
  const limit = typeof body.limit === "number" ? Math.min(200, Math.max(1, Math.trunc(body.limit))) : 50;

  const config = readEventsConfig(cwd);
  if (config.error) return badRequest(config.error);
  const session = config.sessions.find((item) => item.sessionId === sessionId);
  if (!session) return badRequest(`.pi/events.yaml 里没有会话 ${sessionId}`);
  const entry = session.subscriptions.find((item) => item.subscription?.name === name || item.label.includes(`"${name}"`));
  if (!entry) return badRequest(`会话 ${sessionId} 下没有订阅「${name}」`);

  let rule: EventSubscription;
  let draft: boolean;
  if (Object.keys(read.patch).length > 0) {
    const drafted = draftSubscription(cwd, { sessionId, name }, read.patch);
    if (!drafted.ok) return badRequest(drafted.error, drafted.line);
    rule = drafted.subscription;
    draft = true;
  } else {
    if (!entry.subscription) {
      return badRequest(entry.error ?? `订阅「${name}」当前不可用（先修好配置再试运行）`, null);
    }
    rule = entry.subscription;
    draft = false;
  }

  // The server-side filter is the union over every rule on the channel; the
  // draft replaces the saved rule when it exists. This is the stage that
  // decides whether a frame is even sent, so it must be judged as it really is.
  const rules = usableSubscriptions(config)
    .filter((item) => item.subscription.name !== name || item.sessionId !== sessionId)
    .map((item) => ({ projectCwd: cwd, sessionId: item.sessionId, title: item.title, subscription: item.subscription }));
  rules.push({ projectCwd: cwd, sessionId, title: session.title, subscription: rule });
  const channel = desiredChannels(rules).get(`${rule.server}|${rule.workspace}`);
  const coarse = {
    events: channel?.types ?? rule.filter.events,
    entityTypes: channel?.entityTypes ?? rule.filter.entityTypes,
  };

  const events = recentEventsOf(rule.server, rule.workspace).slice(-limit);
  const status = ruleRuntimeStatus(sessionId, rule);
  const running = await isSessionRunning(sessionId).catch(() => false);

  const result = dryRunSubscription(rule, events, coarse, {
    // Only the storm fuse, not every "why not": the gates below are the rule's
    // own budget, and a missing connection is not a gate but a state (reported
    // separately as `connection`).
    pausedReason: sessionEventFacts(sessionId).pausedReason,
    lastWakeAt: status.lastWakeAt,
    hourlyCount: status.hourlyCount,
    maxPerHour: rule.maxPerHour,
    selfQuietSec: rule.selfQuietSec,
    running,
  });

  return NextResponse.json({
    ok: true,
    draft,
    rule: {
      id: rule.id,
      name: rule.name,
      server: rule.server,
      workspace: rule.workspace,
      action: rule.action,
      coalesceSec: rule.coalesceSec,
      match: rule.match,
    },
    coarse,
    summary: describeDryRun(result),
    evaluated: result.evaluated,
    hits: result.hits,
    misses: result.misses,
    blockedBy: result.blockedBy,
    delayedBy: result.delayedBy,
    warnings: result.warnings,
    connection: status.connection,
  });
}
