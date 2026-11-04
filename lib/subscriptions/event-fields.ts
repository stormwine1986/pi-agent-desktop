/**
 * Which fields of an incoming event become the list's columns.
 *
 * The entity-events envelope is documented, but the `key` a list wants to show
 * is a business key that productions put in different places, so it is read
 * from the first path that has it instead of assuming one shape. Everything
 * here is defensive: a missing field becomes null, never an exception, because
 * one malformed event must not stop the stream.
 */
export interface EventColumns {
  eventType: string;
  entityType: string | null;
  workspaceId: string | null;
  state: string | null;
  key: string | null;
  eventId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const found = text(value);
    if (found !== null && found !== "") return found;
  }
  return null;
}

export interface ExtractOptions {
  /** SSE `event:` field, used when the payload has no type of its own. */
  eventName?: string | null;
  /** SSE `id:` field, used when the payload has no event id. */
  sseId?: string | null;
  /** `params.workspaceId` from subscriptions.yaml, when the event omits it. */
  workspaceIdParam?: string | null;
}

export function extractEventColumns(data: unknown, options: ExtractOptions = {}): EventColumns {
  const envelope = asRecord(data);
  const nested = asRecord(envelope?.data);
  const payload = asRecord(envelope?.payload);
  const payloadFields = asRecord(payload?.fields);

  return {
    eventType: firstText(envelope?.eventType, options.eventName, envelope?.type) ?? "message",
    entityType: firstText(envelope?.aggregateType, envelope?.entityType, nested?.entityType),
    workspaceId: firstText(envelope?.workspaceId, nested?.workspaceId, options.workspaceIdParam),
    state: firstText(
      payload?.toState,
      payload?.state,
      payloadFields?.state,
      envelope?.state,
      nested?.state,
    ),
    // Business key: explicit `key` first, then the usual entity-ish aliases.
    key: firstText(
      envelope?.key,
      payload?.key,
      payloadFields?.key,
      nested?.key,
      envelope?.aggregateKey,
      payload?.aggregateKey,
      envelope?.entityKey,
      payload?.entityKey,
    ),
    eventId: firstText(envelope?.eventId, options.sseId),
  };
}
