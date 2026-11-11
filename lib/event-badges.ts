/**
 * Client-side view of `/api/events/subscriptions?cwd=…`.
 *
 * The sidebar gets the *ids* and the health of subscribed sessions from
 * `/api/agent/running` (the existing channel, SSR-000097【会话列表标记】). What a
 * tooltip needs beyond that — which rules, when one last woke the session, how
 * often today — is per project, so it is fetched once per project and merged
 * here. This module is pure: the fetching stays in the component.
 */

export type SubscriptionHealth = "active" | "paused" | "limited" | "unavailable";

export interface SubscriptionRuleView {
  name: string;
  health: SubscriptionHealth;
  reason: string | null;
  lastWakeAt: number | null;
  todayCount: number;
  action: string;
}

export interface SubscriptionBadge {
  sessionId: string;
  count: number;
  health: SubscriptionHealth;
  reason: string | null;
  lastWakeAt: number | null;
  todayCount: number;
  rules: SubscriptionRuleView[];
  /** A rule the file declares but cannot use; shown instead of a healthy count. */
  broken: string[];
}

interface RawSubscription {
  id?: unknown;
  name?: unknown;
  action?: unknown;
  health?: unknown;
  reason?: unknown;
  lastWakeAt?: unknown;
  todayCount?: unknown;
  error?: unknown;
  label?: unknown;
}

interface RawSession {
  sessionId?: unknown;
  health?: unknown;
  reason?: unknown;
  subscriptions?: unknown;
}

const HEALTHS: SubscriptionHealth[] = ["active", "paused", "limited", "unavailable"];

function asHealth(value: unknown, fallback: SubscriptionHealth): SubscriptionHealth {
  return typeof value === "string" && (HEALTHS as string[]).includes(value)
    ? (value as SubscriptionHealth)
    : fallback;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One badge per session. A session with a broken rule counts it: the point of
 * the badge is to say "this session expects to be woken"; hiding a rule that
 * cannot fire would make a misconfiguration look like calm.
 */
export function toSubscriptionBadges(payload: unknown): Record<string, SubscriptionBadge> {
  const badges: Record<string, SubscriptionBadge> = {};
  if (typeof payload !== "object" || payload === null) return badges;
  const sessions = (payload as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return badges;

  for (const raw of sessions as RawSession[]) {
    if (typeof raw?.sessionId !== "string") continue;
    const rules: SubscriptionRuleView[] = [];
    const broken: string[] = [];
    const subscriptions = Array.isArray(raw.subscriptions) ? (raw.subscriptions as RawSubscription[]) : [];

    for (const entry of subscriptions) {
      if (typeof entry?.error === "string" && typeof entry.name !== "string") {
        broken.push(`${typeof entry.label === "string" ? entry.label : "订阅"}：${entry.error}`);
        continue;
      }
      if (typeof entry?.name !== "string") continue;
      rules.push({
        name: entry.name,
        health: asHealth(entry.health, "active"),
        reason: typeof entry.reason === "string" ? entry.reason : null,
        lastWakeAt: asNumber(entry.lastWakeAt),
        todayCount: asNumber(entry.todayCount) ?? 0,
        action: typeof entry.action === "string" ? entry.action : "wake",
      });
    }

    const lastWakeAt = rules.reduce<number | null>(
      (latest, rule) => (rule.lastWakeAt !== null && (latest === null || rule.lastWakeAt > latest) ? rule.lastWakeAt : latest),
      null,
    );
    const todayCount = rules.reduce((sum, rule) => sum + rule.todayCount, 0);
    badges[raw.sessionId] = {
      sessionId: raw.sessionId,
      count: rules.length + broken.length,
      health: asHealth(raw.health, "active"),
      reason: typeof raw.reason === "string" ? raw.reason : null,
      lastWakeAt,
      todayCount,
      rules,
      broken,
    };
  }
  return badges;
}

/** Warn only when something is actually wrong; `active` is the quiet case. */
export function isSubscriptionWarning(health: SubscriptionHealth): boolean {
  return health !== "active";
}

/** `HH:MM` for a tooltip; a missing value reads as "never". */
export function formatWakeTime(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
