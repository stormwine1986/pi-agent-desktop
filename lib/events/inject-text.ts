import type { CoalescedBatch } from "./batch";
import { INJECT_PLACEHOLDERS } from "./config";

/**
 * The text injected into a session when a subscription fires.
 *
 * Two rules from SSR-000097 shape it:
 *
 * 1. **The first line is fixed**: `[事件] <subscriptionId>`. A session can be
 *    woken by several rules and by a person typing; the first line says which
 *    one, so the transcript stays traceable.
 * 2. **The batch must carry the event list**, not just a count: an orchestrator
 *    deciding what to dispatch next has to see *which* things changed. At most
 *    ten lines; the rest is a count.
 *
 * Placeholders are the whitelist in `config.ts`. A template is validated at load
 * time, so an unknown `{{key}}` never reaches this renderer — a missing value
 * here would otherwise be an empty string that reads as a fact.
 */

export const MAX_LISTED_HITS = 10;

export const DEFAULT_INJECT_TEMPLATE = [
  "{{count}} 条变化（{{window}}s 内合批）：",
  "{{events}}",
  "这不是断言：先重读这些实体的当前状态，再决定下一轮怎么派。",
].join("\n");

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** `HH:MM:SS` of an ISO timestamp; an unparseable one is shown as written. */
function clockTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return timestamp;
  return clockTimeOf(parsed);
}

function clockTimeOf(epochMs: number): string {
  const date = new Date(epochMs);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The fixed line that marks a batch as *backfill* — a replayed event, not one
 * that just happened (SSR-000097 M3 / AC-2: "批次内容里能看出这是补的").
 *
 * It is not part of the template either: a batch that claims to be live while
 * describing a four-minute-old transition is exactly the confusion this line
 * prevents, and a project file must not be able to remove it.
 */
function catchUpLine(batch: CoalescedBatch): string | null {
  if (!batch.catchUp) return null;
  const from = batch.catchUpFrom ?? null;
  const to = batch.catchUpTo ?? null;
  const window = from !== null && to !== null
    ? `${clockTimeOf(from)}–${clockTimeOf(to)}`
    : from !== null
      ? `${clockTimeOf(from)}`
      : "断线期间";
  return `[补投] 这是断线后从服务端回放的事件（${window}），不是刚刚发生的`;
}

/** One line of the event list. The key is used only when the envelope had one. */
export function describeHit(hit: CoalescedBatch["hits"][number]): string {
  const subject = hit.key ? `${hit.aggregateType} ${hit.key}` : `${hit.aggregateType} ${hit.aggregateId}`;
  const change = hit.from !== null && hit.to !== null
    ? `${hit.from} → ${hit.to}`
    : hit.to !== null
      ? `→ ${hit.to}`
      : hit.eventType;
  const merged = hit.hitCount > 1 ? `，合并 ${hit.hitCount} 次` : "";
  const who = hit.operator ? `${hit.operator}，` : "";
  return `- ${subject}：${change}（${who}${clockTime(hit.timestamp)}${merged}）`;
}

export function renderEventList(batch: CoalescedBatch): string {
  const listed = batch.hits.slice(0, MAX_LISTED_HITS);
  const lines = listed.map(describeHit);
  const hidden = batch.hits.length - listed.length;
  if (hidden > 0) lines.push(`… 还有 ${hidden} 条`);
  return lines.join("\n");
}

export interface InjectionText {
  /** `${sessionId}#${name}` — printed on the first line. */
  subscriptionId: string;
  text: string;
}

/**
 * Renders one batch. `aggregateType` / `aggregateId` / `from` / `to` / `operator`
 * describe the newest entry of the batch (the batch may span several
 * aggregates; the full list is in `{{events}}`).
 */
export function renderInjection(batch: CoalescedBatch): InjectionText {
  const template = batch.subscription.inject ?? DEFAULT_INJECT_TEMPLATE;
  const latest = batch.hits[batch.hits.length - 1];
  const values: Record<(typeof INJECT_PLACEHOLDERS)[number], string> = {
    count: String(batch.count),
    window: String(Math.max(0, Math.round((batch.closedAt - batch.openedAt) / 1000))),
    events: renderEventList(batch),
    aggregateType: latest?.aggregateType ?? "",
    aggregateId: latest?.aggregateId ?? "",
    workspaceId: latest?.workspaceId ?? batch.subscription.workspace,
    timestamp: latest?.timestamp ?? "",
    operator: latest?.operator ?? "",
    from: latest?.from ?? "",
    to: latest?.to ?? "",
    hitCount: String(latest?.hitCount ?? 0),
  };

  const body = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name: string) => {
    if (!(name in values)) return match; // Cannot happen after load-time validation; leave it visible.
    return values[name as keyof typeof values];
  });

  // The fixed first line is not part of the template: it must not be removable
  // by editing a project file.
  const marker = catchUpLine(batch);
  const text = `[事件] ${batch.subscription.id}\n${marker ? `${marker}\n` : ""}${body.trim()}\n`;
  return { subscriptionId: batch.subscription.id, text };
}
