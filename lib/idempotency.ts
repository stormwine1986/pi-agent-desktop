/**
 * Idempotency keys for the panel's writes (FM-SUBMIT ④).
 *
 * A lost response looks exactly like a failed request, so the user retries — and
 * that retry has to reach the base as the *same* submission, or a create makes a
 * second entity. The key therefore belongs to a logical submission rather than
 * to a request: it is reused while the content is unchanged, and replaced the
 * moment the content changes (another field, another target state, another
 * revision), because that is a genuinely new attempt and replaying the old
 * outcome for it would be wrong.
 *
 * The panel generates the key, not the route: only the caller knows whether the
 * second request is a retry or a new intention.
 */

/** The shape the MCP layer accepts; anything else is replaced by a fresh key. */
const KEY_PATTERN = /^[A-Za-z0-9_\-:.]{8,128}$/;

export interface SubmissionKey {
  /** What was being submitted when this key was made. */
  signature: string;
  key: string;
}

/**
 * The key to use for `signature`, made fresh only when the submission changed.
 *
 * Callers keep the result (a ref will do) and hand it back on the next attempt.
 */
export function submissionKey(
  previous: SubmissionKey | null,
  signature: string,
  make: () => string,
): SubmissionKey {
  if (previous !== null && previous.signature === signature) return previous;
  return { signature, key: make() };
}

/**
 * The key a route should send: the caller's when it is well formed, a generated
 * one otherwise.
 *
 * A request without a key still works — it just cannot be retried safely, which
 * is the state every write was in before this existed.
 */
export function acceptedKey(raw: unknown, make: () => string): string {
  if (typeof raw === "string" && KEY_PATTERN.test(raw)) return raw;
  return make();
}

/** `crypto.randomUUID` is not in older engines; a timestamp keeps keys unique anyway. */
export function newKey(prefix: string): string {
  const unique =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${unique}`;
}
