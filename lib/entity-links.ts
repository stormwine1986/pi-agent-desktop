/**
 * Reading keys out of a text box, and judging them before the base sees them.
 *
 * The panel does not search for entities — a reader gets keys from the
 * conversation and pastes them here — so the only thing it owes the reader is
 * an honest answer per key: is this something the base will actually link?
 *
 * Everything judged here mirrors a check the base performs itself
 * (`traceability-service.ts`): an entity cannot link to itself, both ends must
 * exist and be readable, the target's type must be declared by the relation,
 * both states must be in the relation's allowed lists, and the link must not
 * already be active. The client only says it earlier, so a typo costs no round
 * trip; the server keeps the last word.
 */

/** At most this many keys per submit — one panel screen, one list query. */
export const MAX_LINK_KEYS = 20;

/**
 * Characters a key may hold. Not a guess about the model: anything carrying a
 * quote or a space would have to be escaped into the DQL that looks it up, and
 * a key is never any of those in practice.
 */
export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface ParsedKeys {
  /** Unique keys, in the order they were typed, capped at `MAX_LINK_KEYS`. */
  keys: string[];
  /** How many distinct keys the text held, before the cap. */
  total: number;
  /** Distinct keys the cap left out; shown, never silently dropped. */
  overflow: number;
}

/** Splits on spaces, commas (半角/全角), semicolons and newlines. */
export function parseLinkKeys(text: string): ParsedKeys {
  const seen = new Set<string>();
  const keys: string[] = [];
  let total = 0;
  for (const raw of text.split(/[\s,，;；]+/)) {
    const key = raw.trim();
    if (!key) continue;
    // Two spellings of the same key are one key.
    const id = key.toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    total += 1;
    if (keys.length < MAX_LINK_KEYS) keys.push(key);
  }
  return { keys, total, overflow: Math.max(0, total - MAX_LINK_KEYS) };
}

export type LinkKeyReason = "self" | "invalid" | "not-found" | "type" | "state" | "linked";

export interface LinkKeyCheck {
  /** What the reader typed. */
  key: string;
  /** The entity's own spelling, when one was found. */
  resolvedKey: string;
  ok: boolean;
  reason: LinkKeyReason | null;
  /** One sentence for the row, in the reader's language. */
  detail: string;
  name: string;
  type: string;
  state: string;
}

export interface LinkKeyInput {
  keys: string[];
  /** The entity the links are created from (the downstream end). */
  sourceKey: string;
  /** Entity types this relation declares as its upstream end. */
  targetTypes: string[];
  /** States the relation accepts upstream; empty means "no restriction". */
  allowedTargetStates: string[];
  /** What the workspace actually holds, as `list` answered. */
  found: Array<{ key: string; type: string; name: string; state: string }>;
  /** Upstream keys already linked with this very relation. */
  linkedKeys: string[];
}

/**
 * One verdict per key, in the order they were typed.
 *
 * The order of the checks is the order the base applies them, so the first
 * failing reason a reader sees is the first one the server would have raised.
 */
export function evaluateLinkKeys(input: LinkKeyInput): LinkKeyCheck[] {
  const byId = new Map<string, { key: string; type: string; name: string; state: string }>();
  for (const entry of input.found) byId.set(entry.key.toUpperCase(), entry);
  const linked = new Set(input.linkedKeys.map((key) => key.toUpperCase()));
  const self = input.sourceKey.toUpperCase();
  const targetTypes = new Set(input.targetTypes.map((type) => type.toUpperCase()));
  const allowedStates = new Set(input.allowedTargetStates.map((state) => state.toUpperCase()));

  return input.keys.map((key) => {
    const base: LinkKeyCheck = {
      key,
      resolvedKey: "",
      ok: false,
      reason: null,
      detail: "",
      name: "",
      type: "",
      state: "",
    };
    if (!KEY_PATTERN.test(key)) {
      return { ...base, reason: "invalid", detail: "key 里有非法字符" };
    }
    if (key.toUpperCase() === self) {
      return { ...base, reason: "self", detail: "不能挂到自己" };
    }
    const hit = byId.get(key.toUpperCase());
    if (!hit) {
      return { ...base, reason: "not-found", detail: "这个空间里没有这条（key 区分大小写）" };
    }
    const row = { ...base, resolvedKey: hit.key, name: hit.name, type: hit.type, state: hit.state };
    if (targetTypes.size > 0 && !targetTypes.has(hit.type.toUpperCase())) {
      return { ...row, reason: "type", detail: `这个关系只接 ${input.targetTypes.join(" / ")}` };
    }
    if (allowedStates.size > 0 && !allowedStates.has(hit.state.toUpperCase())) {
      return {
        ...row,
        reason: "state",
        detail: `状态不允许（现在是 ${hit.state}，需 ${input.allowedTargetStates.join(" / ")}）`,
      };
    }
    if (linked.has(hit.key.toUpperCase())) {
      return { ...row, reason: "linked", detail: "已经挂过了" };
    }
    return { ...row, ok: true, reason: null, detail: "可挂" };
  });
}
