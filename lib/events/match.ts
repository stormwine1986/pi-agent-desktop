import type { SubscriptionMatch } from "./config";

/**
 * The normalized descriptor of one domain event (SSR-000097【通用匹配】).
 *
 * The matching layer knows nothing about entity types or state names: it reads
 * what the envelope says and compares it with the rule's predicates. Everything
 * type-specific lives in `.pi/events.yaml`.
 */
export interface EventDescriptor {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  workspaceId: string;
  operator: string;
  revision: number;
  /** `payload.fromState` for a transition; null for `created` and for anything else. */
  from: string | null;
  /** `payload.toState` for a transition, `payload.state` for `created`. */
  to: string | null;
  changedFields: string[];
  timestamp: string;
  /**
   * The key, when the envelope carries one (`entity.created` does). Display
   * only — a rule can never match on it (`match.key` is refused at load time).
   */
  key: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalState(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `DomainEvent` envelope → descriptor, or null when the frame is not an event
 * this layer can judge (no id, no type).
 *
 * `level=envelope` strips field values but keeps `fromState` / `toState` /
 * `changedFields`, so the descriptor is complete without a second read.
 */
export function normalizeEnvelope(envelope: unknown): EventDescriptor | null {
  if (!isRecord(envelope)) return null;
  const eventType = text(envelope.eventType);
  const aggregateId = text(envelope.aggregateId);
  if (!eventType || !aggregateId) return null;

  const payload = isRecord(envelope.payload) ? envelope.payload : {};
  let from: string | null = null;
  let to: string | null = null;
  let key: string | null = null;

  switch (eventType) {
    case "entity.transitioned":
      from = optionalState(payload.fromState);
      to = optionalState(payload.toState);
      break;
    case "entity.created":
      // Creation has no previous state; the new one is the payload's `state`.
      from = null;
      to = optionalState(payload.state);
      key = text(payload.key) || null;
      break;
    default:
      // updated / trace_* / x.* carry no state pair. `from`/`to` stay null so a
      // rule that asks for a state simply does not match them.
      break;
  }

  const changedFields = Array.isArray(payload.changedFields)
    ? payload.changedFields.filter((name): name is string => typeof name === "string")
    : [];

  return {
    eventId: text(envelope.eventId),
    eventType,
    aggregateType: text(envelope.aggregateType),
    aggregateId,
    workspaceId: text(envelope.workspaceId),
    operator: text(envelope.operator),
    revision: typeof envelope.revision === "number" ? envelope.revision : 0,
    from,
    to,
    changedFields,
    timestamp: text(envelope.timestamp),
    key,
  };
}

/**
 * A predicate list matches when the value is in it; `"*"` matches anything,
 * including null. A null value never matches a concrete list: "transitioned to
 * BLOCKED" must not fire on an event that has no state at all.
 */
function matchesValue(predicate: string[] | null, value: string | null): boolean {
  if (!predicate || predicate.length === 0) return true;
  if (predicate.includes("*")) return true;
  return value !== null && predicate.includes(value);
}

/** List against list: at least one of the event's values must be named. */
function matchesAny(predicate: string[] | null, values: string[]): boolean {
  if (!predicate || predicate.length === 0) return true;
  if (predicate.includes("*")) return true;
  return values.some((value) => predicate.includes(value));
}

/**
 * Applies one rule's `match:` block. Every key is optional; an absent key means
 * "any". This is deliberately not an expression language (SSR-000097【边界】):
 * a condition this layer cannot express belongs in the injected prompt, where
 * the model can judge it.
 */
export function matchesSubscription(descriptor: EventDescriptor, match: SubscriptionMatch): boolean {
  return matchesValue(match.eventType, descriptor.eventType)
    && matchesValue(match.aggregateType, descriptor.aggregateType)
    && matchesValue(match.from, descriptor.from)
    && matchesValue(match.to, descriptor.to)
    && matchesValue(match.operator, descriptor.operator)
    && matchesAny(match.changedFields, descriptor.changedFields);
}

/** The union of two filter dimensions, for the shared connection's coarse filter. */
export function union(names: Iterable<string>): string[] {
  return [...new Set(names)].sort();
}
