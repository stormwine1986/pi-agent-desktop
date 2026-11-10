/**
 * Which environment answered, and whether this reader may open it.
 *
 * A link names a *key*, and until now the workbench worked out the environment
 * by asking every configured server until exactly one held that key. That is a
 * guess: it happens to be right while no two stacks share a key, and it silently
 * opens the wrong one the moment they do. `SSR-000092` (ENV-RESOLVE) replaces the
 * guess with a **declaration**: the environment says which instance it is
 * (`initialize.serverInfo._meta.instanceId`, `SSR-000091`), and the workbench
 * compares that with what the link asked for / what the connection config pins.
 *
 * The rules this module encodes, in the order they are applied:
 *
 * 1. A declaration beats probing. A link may carry `instanceId`; that selects the
 *    environment, it is never evidence (AC-8).
 * 2. A deployment pin in `mcp.json` (`instanceId` on the server entry) is the
 *    only comparator. It comes from connection config, never from a request, so
 *    a link's id can never turn an open into a checked one (AC-5b / AC-8).
 * 3. Declared + comparator + mismatch → refuse. The copy names the declaration,
 *    the expectation and what the reader can do (`SSR-000033`, MCP-5).
 * 4. Declared without a comparator → open, but say "未验真 (未 pin)". No claim of
 *    verification, and no refusal (AC-5b).
 * 5. Undeclared (older deployment) → open, but say "该环境未声明身份（降级）".
 *    A missing declaration never kills an older environment (ENV-ID ⑥).
 *
 * Everything here is pure: the routes do the handshake and hand the payloads in.
 */

/** What an environment says about itself. Absent fields stay absent. */
export interface ServerIdentity {
  instanceId: string;
  instanceName?: string;
  /** CHG-1's `appVersion` (git sha) — build provenance, not identity. */
  appVersion?: string;
}

/** How much of the answer this reader may trust, and why. */
export type IdentityVerdict = "verified" | "unverified" | "degraded";

/** The verdict a panel shows and an operator reads back. */
export interface EntityIdentity {
  verdict: IdentityVerdict;
  /** What the endpoint declared; absent when it declared nothing. */
  instanceId?: string;
  instanceName?: string;
  /** The value `mcp.json` pinned, when it pinned one — never a link's request. */
  expected?: string;
  /** Where `expected` came from — never a request parameter or header. */
  source: "config" | "none";
  /** One sentence for a tooltip / a log line. */
  detail: string;
}

/** One configured entry a refusal can point at, so the reader can see the field. */
export interface IdentityCandidate {
  server: string;
  instanceId?: string;
  instanceName?: string;
  pin?: string;
  workspace?: string;
}

/** A refusal the panel renders as-is; every field AC-5 asks for is present. */
export interface IdentityRefusal {
  code: "INSTANCE_MISMATCH";
  status: 409;
  error: string;
  expected: string;
  actual: string;
  candidates: IdentityCandidate[];
}

export type IdentityJudgement =
  | { ok: true; identity: EntityIdentity }
  | { ok: false; refusal: IdentityRefusal };

/**
 * Spellings an environment must never use for "no identity" (`SSR-000091` AC-5).
 * Reading one as a declaration would let a placeholder refuse a perfectly good
 * link; reading it as "undeclared" keeps the older-deployment path working.
 */
const PLACEHOLDERS = new Set(["unknown", "local", "null", "undefined", "none"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function declaredText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return PLACEHOLDERS.has(trimmed.toLowerCase()) ? null : trimmed;
}

/** The identity fields of one object, or null when it declares none. */
function fieldsOf(record: Record<string, unknown>): ServerIdentity | null {
  // `_meta.instance` is tolerated next to `_meta.instanceId`: 091 fixes the
  // names, not the nesting of a future object, and both spellings are one
  // declaration once read here.
  const instance = asRecord(record.instance);
  const instanceId = declaredText(record.instanceId) ?? declaredText(instance?.instanceId);
  if (!instanceId) return null;
  const instanceName = declaredText(record.instanceName) ?? declaredText(instance?.name) ?? declaredText(record.name);
  const appVersion = declaredText(record.appVersion) ?? declaredText(instance?.appVersion) ?? declaredText(record.version);
  return {
    instanceId,
    ...(instanceName ? { instanceName } : {}),
    ...(appVersion ? { appVersion } : {}),
  };
}

/**
 * The declaration a payload carries, or null when it carries none.
 *
 * Understands the shapes the base actually answers with: an `initialize` result
 * (`serverInfo._meta`), a bare `serverInfo`, and `about_me` (identity at the top
 * level, or under `instance` / `environment`). Breadth-first and shallow on
 * purpose: a nested tool result must not be mined for something that merely
 * looks like an id.
 */
export function identityFrom(payload: unknown): ServerIdentity | null {
  let level: Array<Record<string, unknown>> = [];
  const root = asRecord(payload);
  if (root) level.push(root);

  for (let depth = 0; depth < 4 && level.length > 0; depth += 1) {
    const next: Array<Record<string, unknown>> = [];
    for (const record of level) {
      const declared = fieldsOf(record);
      if (declared) return declared;
      for (const key of ["_meta", "meta", "serverInfo", "instance", "environment", "env"]) {
        const nested = asRecord(record[key]);
        if (nested) next.push(nested);
      }
    }
    level = next;
  }
  return null;
}

/** Convenience name for the handshake's `serverInfo`. */
export function declaredIdentityOf(serverInfo: unknown): ServerIdentity | null {
  return identityFrom(serverInfo);
}

function candidateText(candidate: IdentityCandidate): string {
  const name = candidate.instanceName ? `「${candidate.instanceName}」` : "";
  if (candidate.instanceId) return `${candidate.server}${name}（instanceId=${candidate.instanceId}）`;
  if (candidate.pin) return `${candidate.server}（mcp.json pin instanceId=${candidate.pin}）`;
  return `${candidate.server}（未声明身份）`;
}

export function identityMismatchRefusal(input: {
  server: string;
  why: string;
  expected: string;
  actual: string;
  candidates: IdentityCandidate[];
}): IdentityRefusal {
  const seen = new Map<string, IdentityCandidate>();
  for (const candidate of input.candidates.length > 0
    ? input.candidates
    : [{ server: input.server, instanceId: input.actual }]) {
    seen.set(candidate.server, candidate);
  }
  const candidates = [...seen.values()];
  const declared = candidates.map(candidateText).join("、");
  return {
    code: "INSTANCE_MISMATCH",
    status: 409,
    expected: input.expected,
    actual: input.actual,
    candidates,
    error:
      `${input.why}（code=INSTANCE_MISMATCH）：期望 instanceId=${input.expected}，实际 ${declared}。`
      + `请确认 mcp.json 里这条 server 的地址与 token 指向哪套环境，或改用指向该环境的链接；`
      + `工作台不会在一个没有核对过的环境里打开这条实体。`,
  };
}

export interface IdentityJudgementInput {
  /** The configured entry the entity is being read through. */
  server: string;
  /** What the endpoint declared, or null when it declared nothing. */
  actual: ServerIdentity | null;
  /** `instanceId` the link asked for — a selector, never evidence. */
  requested?: string | null;
  /** `instanceId` pinned in the connection config (`mcp.json`). */
  pinned?: string | null;
  /** Every entry that answered with a declaration, for the refusal copy. */
  candidates?: IdentityCandidate[];
}

function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/**
 * The judgement for one connection: open (with a verdict) or refuse (with copy).
 *
 * Order matters and mirrors ENV-RESOLVE ②/④: a link/config contradiction is
 * refused before any read; a declaration that contradicts the requirement is
 * refused; an absent declaration degrades instead of refusing.
 */
export function judgeIdentity(input: IdentityJudgementInput): IdentityJudgement {
  const requested = clean(input.requested);
  const pinned = clean(input.pinned);
  const actual = input.actual;
  const candidates = input.candidates ?? [];

  // A link and a pin that disagree can never both be satisfied: say so before
  // opening anything, and name the pin as the value that must be changed.
  if (requested && pinned && requested !== pinned) {
    return {
      ok: false,
      refusal: identityMismatchRefusal({
        server: input.server,
        why: "链接要求的环境与这个项目在 mcp.json 里 pin 的环境不一致",
        expected: requested,
        actual: pinned,
        candidates: [{ server: input.server, pin: pinned }, ...candidates],
      }),
    };
  }

  if (!actual) {
    // Older deployment: no declaration anywhere. Open it, label it, and never
    // claim it was verified — but never refuse it for being old, either.
    return {
      ok: true,
      identity: {
        verdict: "degraded",
        // Nothing was compared, so there is no expectation to report: the link's
        // id only said which environment the writer meant (AC-8).
        source: "none",
        detail: requested
          ? `该环境未声明身份（降级），未验真：链接要求 instanceId=${requested}，端点未声明，无法核对，只能按 workspace + key 定位。`
          : "该环境未声明身份（降级），未验真：没有可对照的 instanceId，只能按 workspace + key 定位。",
      },
    };
  }

  // The comparator is the deployment pin and nothing else. A link's `instanceId`
  // selected this entry (and is refused above when it contradicts one); taking it
  // as `expected` too made a request parameter verify itself (AC-5b / AC-8).
  const expectation = pinned;
  if (requested && actual.instanceId !== requested) {
    return {
      ok: false,
      refusal: identityMismatchRefusal({
        server: input.server,
        why: "链接要求的环境与端点自报的环境不一致",
        expected: requested,
        actual: actual.instanceId,
        candidates: [{ server: input.server, instanceId: actual.instanceId, instanceName: actual.instanceName }, ...candidates],
      }),
    };
  }
  if (pinned && actual.instanceId !== pinned) {
    return {
      ok: false,
      refusal: identityMismatchRefusal({
        server: input.server,
        why: "连接配置 pin 的环境与端点自报的环境不一致",
        expected: pinned,
        actual: actual.instanceId,
        candidates: [{ server: input.server, instanceId: actual.instanceId, instanceName: actual.instanceName, pin: pinned }, ...candidates],
      }),
    };
  }

  return {
    ok: true,
    identity: {
      verdict: expectation ? "verified" : "unverified",
      instanceId: actual.instanceId,
      ...(actual.instanceName ? { instanceName: actual.instanceName } : {}),
      ...(expectation ? { expected: expectation } : {}),
      source: pinned ? "config" : "none",
      detail: expectation
        ? `已核对：端点声明 instanceId=${actual.instanceId}${actual.instanceName ? `（${actual.instanceName}）` : ""}，与 mcp.json 的 pin 一致。`
        : `未验真：端点声明 instanceId=${actual.instanceId}${actual.instanceName ? `（${actual.instanceName}）` : ""}，但 mcp.json 没有 pin，没有可对照的期望值（未 pin）${requested ? `；链接里的 instanceId=${requested} 只用于选择，不作对照` : ""}。`,
    },
  };
}

/**
 * Whether two surfaces of the *same* connection agree with each other.
 *
 * The handshake is the primary source (ENV-RESOLVE ②); `about_me` is the
 * per-session secondary check. A connection that declares one id in the
 * handshake and another in `about_me` has no coherent identity to trust — that
 * is a declaration that contradicts itself, so it is refused rather than read.
 * When either side says nothing, there is nothing to compare.
 */
export function judgeConsistency(input: {
  server: string;
  primary: ServerIdentity | null;
  secondary: ServerIdentity | null;
}): IdentityRefusal | null {
  if (!input.primary || !input.secondary) return null;
  if (input.primary.instanceId === input.secondary.instanceId) return null;
  return identityMismatchRefusal({
    server: input.server,
    why: "同一次连接里两处身份声明不一致（initialize 与 about_me）",
    expected: input.primary.instanceId,
    actual: input.secondary.instanceId,
    candidates: [
      { server: `${input.server} (initialize)`, instanceId: input.primary.instanceId, instanceName: input.primary.instanceName },
      { server: `${input.server} (about_me)`, instanceId: input.secondary.instanceId, instanceName: input.secondary.instanceName },
    ],
  });
}
