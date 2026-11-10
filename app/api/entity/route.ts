import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { callMcpTool, readServerIdentity, resolveMcpTarget, type McpHttpTarget } from "@/lib/mcp-call";
import { globalMcpConfigPath, projectMcpConfigPath } from "@/lib/mcp-config-read";
import { asRecord, asStrings, availableRoutesOf, linkOptionsOf, rolesIn, writableFieldsOf, type AvailableRoute, type LinkOption } from "@/lib/entity-permissions";
import {
  declaredIdentityOf,
  identityFrom,
  identityMismatchRefusal,
  judgeConsistency,
  judgeIdentity,
  type EntityIdentity,
  type IdentityCandidate,
  type IdentityRefusal,
  type ServerIdentity,
} from "@/lib/entity-identity";
import { sameMcpServer } from "@/lib/mcp-server-name";
import { acceptedKey } from "@/lib/idempotency";

export const dynamic = "force-dynamic";

/**
 * One entity, ready to render: its type definition, its current fields, and
 * which of those this reader may write.
 *
 * Writing goes through the same tool a conversation uses (`update`), with the
 * revision the panel last read — so a form and a chat cannot disagree about
 * what the server accepts, and a stale form cannot overwrite a newer edit.
 * See `FM-SUBMIT` and `FM-FIELD-PERM`.
 */
export interface EntityResponse {
  /** The channel that answered; a clicked key may not have named one. */
  server: string;
  workspace: string;
  type: string;
  key: string;
  /** Type-level display name, e.g. "产品功能". */
  typeLabel: string;
  name: string;
  state: string;
  revision: number;
  /** Only the fields this reader may see; a hidden field is absent, not empty. */
  fields: Record<string, unknown>;
  /**
   * Field names the server withheld. The client needs these to tell "无权看"
   * apart from "这个字段没填" — both otherwise look like a missing key.
   */
  hiddenFields: string[];
  /** Field definitions in declaration order; the client renders from these. */
  properties: unknown[];
  lifecycle: unknown;
  /** Roles this reader holds in this workspace, so the panel can judge write access. */
  roles: string[];
  /** Fields this reader may change in the entity's current state. */
  writableFields: string[];
  /** Transitions this reader may take from the current state. */
  routes: AvailableRoute[];
  /**
   * Relations this type declares and this reader may write, computed the same
   * way as `writableFields` — the panel offers what the model allows, not what
   * it happens to have seen linked already.
   */
  linkOptions: LinkOption[];
  /**
   * Which environment answered, and how far that was checked (ENV-RESOLVE 4/5).
   * The panel shows the verdict; the ids are kept so a wrong opening can be
   * attributed afterwards instead of guessed at.
   */
  identity: EntityIdentity;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The `get` tool answers a flat entity or wraps it under `entity`; accept both. */
function unwrapEntity(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.key === "string") return record;
  const inner = record.entity;
  if (typeof inner === "object" && inner !== null && typeof (inner as Record<string, unknown>).key === "string") {
    return inner as Record<string, unknown>;
  }
  return null;
}

interface Target {
  target: McpHttpTarget;
  server: string;
  workspace: string;
  key: string;
  /** How far the environment was checked, and what was compared. */
  identity: EntityIdentity;
  /**
   * Already read while resolving, so opening does not read the same key twice.
   * It is a snapshot of the moment it was read: after a write it is the state
   * *before* the write, so a response built from it reports the old revision
   * (`DEFECT-000085`). Only a GET may reuse it; POST passes the write's own
   * answer instead (and lets `loadEntity` re-read when that answer has none).
   */
  entity?: Record<string, unknown>;
}

/**
 * A failed read. `code` is what the panel needs to say the right thing:
 * `channel` is wiring (`mcp.json`), `entity` / `metadata` are the entity or its
 * type not arriving (only there does "元数据不齐，表单不渲染" (FM-META ①) apply),
 * and `instance-mismatch` is an environment that is not the one the link asked
 * for — nothing is opened then (ENV-RESOLVE ④).
 */
interface Failure {
  error: string;
  status: number;
  code?: "channel" | "entity" | "metadata" | "instance-mismatch";
  /** Set for `instance-mismatch`: what was required and what answered. */
  expected?: string;
  actual?: string;
  candidates?: IdentityCandidate[];
}

/** Every server named by the project's and the global `mcp.json`, project first. */
function candidateServers(cwd: string): string[] {
  const names: string[] = [];
  for (const file of [projectMcpConfigPath(cwd), globalMcpConfigPath(getAgentDir())]) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
      for (const name of Object.keys(parsed.mcpServers ?? {})) {
        if (!names.includes(name)) names.push(name);
      }
    } catch {
      // A missing or unreadable file simply offers no candidates.
    }
  }
  return names;
}

interface Attempt {
  name: string;
  target?: McpHttpTarget;
  /** null when the endpoint declared no identity (older deployment). */
  identity: ServerIdentity | null;
  /** Why the handshake did not produce a `serverInfo`, when it did not. */
  handshakeError?: string;
  /** The entity the server answered with, which is what names its space. */
  entity?: Record<string, unknown>;
  error?: string;
}

/** One configured entry, with the environment it says it is. */
async function describeServer(cwd: string, agentDir: string, name: string): Promise<Attempt> {
  const resolved = resolveMcpTarget(agentDir, cwd, name);
  if (!resolved.ok) return { name, identity: null, handshakeError: resolved.error };
  const handshake = await readServerIdentity(resolved.target, cwd);
  if (!handshake.ok) {
    return { name: resolved.target.name, target: resolved.target, identity: null, handshakeError: handshake.error };
  }
  return {
    name: resolved.target.name,
    target: resolved.target,
    identity: declaredIdentityOf(handshake.reading.serverInfo),
  };
}

function refusalFailure(refusal: IdentityRefusal): Failure {
  return {
    error: refusal.error,
    status: refusal.status,
    code: "instance-mismatch",
    expected: refusal.expected,
    actual: refusal.actual,
    candidates: refusal.candidates,
  };
}

/**
 * The probed hits, as a refusal reports them: which entry answered, which space
 * it answered in, and whether it declares an environment at all.
 *
 * Sorted, deliberately: a refusal must read the same whatever order the entries
 * are written in — write order deciding the answer is the defect this refusal
 * exists to stop (`SSR-000092` ③).
 */
function hitCandidates(attempts: Attempt[]): IdentityCandidate[] {
  return attempts
    .map((attempt): IdentityCandidate => ({
      server: attempt.name,
      workspace: text(attempt.entity?.workspaceId),
      ...(attempt.identity?.instanceId ? { instanceId: attempt.identity.instanceId } : {}),
      ...(attempt.identity?.instanceName ? { instanceName: attempt.identity.instanceName } : {}),
      ...(attempt.target?.pinnedInstanceId ? { pin: attempt.target.pinnedInstanceId } : {}),
    }))
    .sort((a, b) => (a.workspace ?? "").localeCompare(b.workspace ?? "") || a.server.localeCompare(b.server));
}

function candidateLine(candidate: IdentityCandidate): string {
  const space = candidate.workspace ? `空间 ${candidate.workspace}` : "空间未知";
  const environment = candidate.instanceId ? `instanceId=${candidate.instanceId}` : "未声明身份";
  return `${candidate.server}（${space}，${environment}）`;
}

/**
 * Hits folded by the **environment** they point at, not by the entry that names
 * it (`TASK-000023` gap 1).
 *
 * Two entries may be two names for one place: `entity-base` and
 * `entity-base-alias` both point at the demo stack. Probing then produced two
 * hits in one space, which looked like the unsolvable tie `DEFECT-000084`
 * refuses — even though there is only one environment to open. The merge rules:
 *
 * 1. a declared `instanceId` decides: same id → one environment, different ids →
 *    two (the tie stands);
 * 2. a declared id on one side and nothing on the other never merge — nothing
 *    proves they are the same place, so the conservative refusal stays;
 * 3. with no declaration on either side, the same connection (`url` + headers)
 *    is one environment; a different url is not.
 *
 * `target.fingerprint` cannot be the key: it hashes the `server` name too
 * (`lib/mcp-call.ts`), so two aliases always differ and a merge could never
 * happen. No extra handshake is made for this — the attempts are the ones
 * `describeAll()` already holds (AC-6).
 */
function environmentKeyOf(attempt: Attempt): string {
  if (attempt.identity?.instanceId) return `id:${attempt.identity.instanceId}`;
  const headers = attempt.target?.headers ?? {};
  const pairs = Object.keys(headers)
    .sort()
    .map((name) => [name, headers[name]] as const);
  return `conn:${attempt.target?.url ?? ""}|${JSON.stringify(pairs)}`;
}

interface HitEnvironment {
  key: string;
  members: Attempt[];
}

function groupHits(hits: Attempt[]): HitEnvironment[] {
  const byKey = new Map<string, Attempt[]>();
  for (const hit of hits) {
    const key = environmentKeyOf(hit);
    const members = byKey.get(key);
    if (members) members.push(hit);
    else byKey.set(key, [hit]);
  }
  return [...byKey.entries()].map(([key, members]) => ({ key, members }));
}

/**
 * The entry that speaks for one environment — deterministic, so a regression can
 * assert the same answer whatever order `mcp.json` lists the entries in.
 *
 * The link's own `server` wins (that name is this project's instruction, not a
 * guess — `DEFECT-000084`), then an entry that pins its environment, then
 * dictionary order of the entry name.
 */
function representativeOf(environment: HitEnvironment, server: string | null): Attempt {
  const ranked = [...environment.members].sort((a, b) => {
    const namedA = server !== null && sameMcpServer(a.name, server) ? 0 : 1;
    const namedB = server !== null && sameMcpServer(b.name, server) ? 0 : 1;
    if (namedA !== namedB) return namedA - namedB;
    const pinnedA = a.target?.pinnedInstanceId ? 0 : 1;
    const pinnedB = b.target?.pinnedInstanceId ? 0 : 1;
    if (pinnedA !== pinnedB) return pinnedA - pinnedB;
    return a.name.localeCompare(b.name);
  });
  return ranked[0];
}

/** One candidate per environment, sorted so write order cannot reach the copy. */
function environmentCandidates(environments: HitEnvironment[], server: string | null): IdentityCandidate[] {
  return environments
    .map((environment) => hitCandidates([representativeOf(environment, server)])[0])
    .sort((a, b) => (a.workspace ?? "").localeCompare(b.workspace ?? "") || a.server.localeCompare(b.server));
}

/**
 * Several **environments** hold the key and nothing tells them apart.
 *
 * Two older deployments that share a space and a key naming scheme are
 * indistinguishable by `(workspace, key)`, and with no declaration to compare
 * the only thing left is `mcp.json` write order — an open that "looks opened but
 * belongs elsewhere", which `AR-000011` / `SSR-000092` ④ forbid. So the answer
 * is a refusal that names every candidate, never `scoped[0]`.
 *
 * Candidates are the merged environments, not the entries: two names for one
 * place are one candidate, and listing them separately produced copy that
 * contradicted itself (`env-alias:ins_demo`、`env-localhost:ins_demo`).
 */
function ambiguousHits(input: {
  key: string;
  workspace: string | null;
  hits: Attempt[];
  scoped: Attempt[];
  environments: HitEnvironment[];
  server: string | null;
}): Failure {
  const { key, workspace, hits, scoped, environments, server } = input;
  const candidates = environmentCandidates(environments, server);
  const listed = candidates.map(candidateLine).join("、");
  const fix = "请给其中一条加 instanceId（mcp.json 里 pin，或部署时声明），或改用带 instanceId 的链接。";
  const error = scoped.length > 1
    ? `${environments.length} 个环境在空间 ${workspace} 里都认得 ${key}（${listed}），按书写顺序挑一个就是归属出错，无法确定打开哪一个。${fix}`
    : workspace
      ? `${hits.length} 个 server 都认得 ${key}（${listed}），链接里的空间 ${workspace} 与它们都不一致，也没有可对照的 instanceId，无法确定打开哪一个。${fix}`
      : `${hits.length} 个 server 都认得 ${key}（${listed}），链接没有指明空间，也没有可对照的 instanceId，无法确定打开哪一个。${fix}`;
  return { error, status: 409, code: "channel", candidates };
}

/** Every entry that said which environment it is, for a refusal's copy. */
function declarationsOf(attempts: Attempt[]): IdentityCandidate[] {
  return attempts
    .filter((attempt) => attempt.identity)
    .map((attempt) => ({
      server: attempt.name,
      instanceId: attempt.identity?.instanceId,
      ...(attempt.identity?.instanceName ? { instanceName: attempt.identity.instanceName } : {}),
      ...(attempt.target?.pinnedInstanceId ? { pin: attempt.target.pinnedInstanceId } : {}),
    }));
}

/**
 * Reads the entity through the entry the declaration belongs to.
 *
 * A probe may already have the entity; then it is not fetched a second time
 * (AC-6). A refused identity never reaches a read, so a mismatched environment
 * cannot answer "here it is" and look opened.
 */
async function openOn(
  attempt: Attempt,
  identity: EntityIdentity,
  workspace: string | null,
  key: string,
  entity?: Record<string, unknown>,
): Promise<Target | Failure> {
  if (!attempt.target) return { error: attempt.handshakeError ?? "这个 server 没有可用的地址", status: 502, code: "channel" };
  let loaded = entity;
  if (!loaded) {
    const found = await callMcpTool(attempt.target, "get", { id: key, includeAttachments: false });
    if (!found.ok) return { error: found.error, status: 502, code: "entity" };
    loaded = unwrapEntity(found.value) ?? undefined;
    if (!loaded) return { error: "服务器没有返回这条实体", status: 502, code: "entity" };
  }
  return {
    target: attempt.target,
    server: attempt.name,
    workspace: text(loaded.workspaceId) || workspace || "",
    key,
    identity,
    entity: loaded,
  };
}

/**
 * Works out which server answers for this key — by declaration, not by luck.
 *
 * The order, none of which may be skipped (ENV-RESOLVE ②):
 * 1. this project's `mcp.json` decides which entries exist at all, and the link's
 *    channel names the first candidate;
 * 2. each entry's environment is read from its handshake (`initialize`), cached
 *    per `(cwd, server)` and invalidated by any change to the entry;
 * 3. an `instanceId` on the link selects the entry that declares it — a mismatch
 *    is refused, never resolved by "the only hit" (the guess this replaces);
 * 4. only an environment that declares *nothing* is probed by workspace + key:
 *    one hit may open (labelled degraded), several are refused with the list —
 *    same space included; only the entry the link names may break that tie.
 *
 * Probing counts **environments**, not entries (`TASK-000023` gap 1): several
 * `mcp.json` names for one stack are one hit, so they open instead of raising a
 * tie nobody can satisfy. See `environmentKeyOf`.
 *
 * A named channel this project does not configure is still a hint, not a
 * demand: every person's `.pi/mcp.json` names its own endpoint, so a reply
 * carried from another project must stay openable — that is the degraded path.
 */
async function pickTarget(
  cwd: string,
  key: string,
  server: string | null,
  workspace: string | null,
  requested: string | null,
): Promise<Target | Failure> {
  const agentDir = getAgentDir();
  const names = candidateServers(cwd);
  if (names.length === 0) {
    return { error: "这个项目没有配置任何 MCP 服务器，无法确定这条实体在哪", status: 400, code: "channel" };
  }

  const ordered = server
    ? [
      ...names.filter((name) => sameMcpServer(name, server)),
      ...names.filter((name) => !sameMcpServer(name, server)),
    ]
    : names;
  const namedName = server ? names.find((name) => sameMcpServer(name, server)) : undefined;

  /**
   * Every entry, handshaked once. Deliberately lazy: opening through the entry
   * the link names must not connect to the rest of the project's servers, or one
   * open would cost one handshake per configured entry (AC-6).
   */
  const describeAll = async () => {
    const attempts = await Promise.all(ordered.map((name) => describeServer(cwd, agentDir, name)));
    const usable = attempts.filter((attempt) => attempt.target !== undefined);
    return { attempts, usable, declarations: declarationsOf(usable) };
  };

  // The named entry, on its own: one handshake for the environment it declares.
  if (namedName) {
    const named = await describeServer(cwd, agentDir, namedName);
    const declaresRequested = requested !== null && named.identity?.instanceId === requested;
    if (declaresRequested || (requested === null && named.identity)) {
      const decided = judgeIdentity({
        server: named.name,
        actual: named.identity,
        requested,
        pinned: named.target?.pinnedInstanceId,
      });
      if (!decided.ok) return refusalFailure(decided.refusal);
      return openOn(named, decided.identity, workspace, key);
    }
  }

  const { attempts, usable, declarations } = await describeAll();
  const named = namedName ? usable.find((attempt) => sameMcpServer(attempt.name, namedName)) : undefined;

  // 3. The link's declaration selects the environment before any key probing.
  if (requested) {
    const match = usable.find((attempt) => attempt.identity?.instanceId === requested);
    if (match) {
      const decided = judgeIdentity({
        server: match.name,
        actual: match.identity,
        requested,
        pinned: match.target?.pinnedInstanceId,
        candidates: declarations,
      });
      if (!decided.ok) return refusalFailure(decided.refusal);
      return openOn(match, decided.identity, workspace, key);
    }
    if (named?.identity) {
      // The entry the link names says it is another environment: refuse with its
      // own reason (a contradicting pin is named as a pin, not as a stranger).
      const decided = judgeIdentity({
        server: named.name,
        actual: named.identity,
        requested,
        pinned: named.target?.pinnedInstanceId,
        candidates: declarations,
      });
      if (!decided.ok) return refusalFailure(decided.refusal);
    } else if (!named && declarations.length > 0) {
      // No channel to fall back on, and every environment that says anything
      // says something else: there is no safe choice to make here.
      return refusalFailure(identityMismatchRefusal({
        server: "已配置的 server",
        why: "链接要求的环境与已配置 server 自报的环境都不一致",
        expected: requested,
        actual: declarations[0]?.instanceId ?? "(未声明)",
        candidates: declarations,
      }));
    }
    // Otherwise the environment declares nothing (older deployment): fall through
    // to the probing path below, which opens but labels the result as degraded.
  }

  // 1./2. The project's own entry answers when it declares a matching identity.
  if (named?.identity) {
    const decided = judgeIdentity({
      server: named.name,
      actual: named.identity,
      requested,
      pinned: named.target?.pinnedInstanceId,
      candidates: declarations,
    });
    if (!decided.ok) return refusalFailure(decided.refusal);
    return openOn(named, decided.identity, workspace, key);
  }

  // 4. No entry of this project answers, or none declares an identity: probe.
  const probed = await Promise.all(usable.map(async (attempt): Promise<Attempt> => {
    const found = await callMcpTool(attempt.target!, "get", { id: key, includeAttachments: false });
    const entity = found.ok ? unwrapEntity(found.value) : null;
    return entity
      ? { ...attempt, entity }
      : { ...attempt, error: found.ok ? "没有这条实体" : found.error };
  }));

  const hits = probed.filter((attempt) => attempt.entity !== undefined);
  // The space narrows identical keys: the demo stack and the test stack hold the
  // same kinds of keys, and a link says which one it means.
  const scoped = workspace
    ? hits.filter((attempt) => text(attempt.entity?.workspaceId) === workspace)
    : [];
  // Hits are folded by environment before any tie is judged (`TASK-000023`
  // gap 1): two entry names for one stack are one hit, not an unsolvable tie.
  const considered = scoped.length > 0 ? scoped : hits;
  const environments = groupHits(considered);
  // One hit is the answer even when the link's space disagrees (a stale or
  // mistyped space is not a reason to withhold the only entity there is).
  // Several environments in one space are a tie the space cannot break: the one
  // thing that may break it is the entry the link names, because that name is
  // this project's own instruction — everything else is write order, which is not
  // an answer (see `ambiguousHits`).
  const namedHit = environments.length > 1 && server
    ? considered.find((attempt) => sameMcpServer(attempt.name, server))
    : undefined;
  // The entry that speaks for its environment: deterministic, so the response's
  // `server` does not depend on `mcp.json` write order.
  const hit = namedHit
    ?? (environments.length === 1 ? representativeOf(environments[0], server) : undefined);
  if (hit) {
    const decided = judgeIdentity({
      server: hit.name,
      actual: hit.identity,
      requested,
      pinned: hit.target?.pinnedInstanceId,
      candidates: declarations,
    });
    if (!decided.ok) return refusalFailure(decided.refusal);
    return openOn(hit, decided.identity, workspace, key, hit.entity);
  }

  const namedAttempt = server ? attempts.find((attempt) => sameMcpServer(attempt.name, server)) : undefined;
  if (namedAttempt) {
    return {
      error: namedAttempt.handshakeError ?? namedAttempt.error ?? `服务器 ${namedAttempt.name} 没有这条实体`,
      status: 502,
      code: "entity",
    };
  }

  if (environments.length > 1) return ambiguousHits({ key, workspace, hits, scoped, environments, server });

  const missing = server
    ? `这个项目没有名为 "${server}" 的 server（已配置：${names.join("、")}），`
    : "";
  return {
    error: `${missing}也没有哪个 server 认得 ${key}。链接里的 server 是写它的那个项目的 mcp.json 名字，改成本项目的名字、或回到那个项目打开。`,
    status: 404,
    code: "channel",
  };
}

async function resolveTarget(search: URLSearchParams): Promise<Target | Failure> {
  const cwd = search.get("cwd");
  const server = search.get("server");
  const workspace = search.get("workspace");
  const key = search.get("key");
  // What the link asked for (ENV-RESOLVE ①). A selector, never evidence: it is
  // compared against a declaration, it does not replace one (AC-8).
  const requested = search.get("instanceId");

  if (!cwd) return { error: "cwd is required", status: 400 };
  if (!key) return { error: "key is required", status: 400 };

  return pickTarget(cwd, key, server, workspace, requested);
}

/**
 * Reads the entity, its type definition and this reader's roles in one go.
 *
 * The environment was judged before the read (`pickTarget`); this is where the
 * second source is compared. `about_me` is the per-session secondary evidence
 * (ENV-RESOLVE 2), and a connection whose two surfaces disagree has no coherent
 * identity to trust — so it is refused here rather than displayed as if it were
 * the environment the link asked for.
 */
async function loadEntity(target: Target): Promise<{ payload: EntityResponse } | Failure> {
  const { server, workspace, key } = target;
  // `get` rejects a `workspaceId` (it answers nothing), so it is not passed; the
  // entity reports its own.
  let entity = target.entity;
  if (!entity) {
    const entityResult = await callMcpTool(target.target, "get", { id: key, includeAttachments: false });
    if (!entityResult.ok) return { error: entityResult.error, code: "entity", status: 502 };
    entity = unwrapEntity(entityResult.value) ?? undefined;
    if (!entity) return { error: "服务器没有返回这条实体", code: "entity", status: 502 };
  }

  const type = text(entity.type);
  if (!type) return { error: "无法确定实体类型", code: "entity", status: 502 };
  // The entity's own space wins over the one the link claims: a stale or foreign
  // link must not relabel a readable entity into the wrong space, which would
  // also judge this reader's roles against a space it holds nothing in.
  const scope = text(entity.workspaceId) || workspace || "";

  const [metadataResult, meResult] = await Promise.all([
    callMcpTool(target.target, "get_metadata", { type }),
    callMcpTool(target.target, "about_me", {}),
  ]);
  // The type definition is what the form is built from, so this is the one
  // failure the panel explains as "元数据不齐" (FM-META 1).
  if (!metadataResult.ok) return { error: metadataResult.error, code: "metadata", status: 502 };

  const primary: ServerIdentity | null = target.identity.instanceId
    ? { instanceId: target.identity.instanceId, instanceName: target.identity.instanceName }
    : null;
  const secondary = meResult.ok ? identityFrom(meResult.value) : null;
  const conflict = judgeConsistency({ server, primary, secondary });
  if (conflict) return refusalFailure(conflict);

  const metadata = asRecord(metadataResult.value) ?? {};
  const fields = asRecord(entity.fields) ?? {};
  const hiddenFields = asStrings(entity.hiddenFields);
  const state = text(entity.state) || text(fields.state);
  const roles = meResult.ok ? rolesIn(meResult.value, scope) : [];

  // The panel and the log both read this: which id was compared with what, and
  // which verdict followed (ENV-RESOLVE 5). Never extend the claim beyond what
  // was actually compared.
  let identity = target.identity;
  if (primary && secondary) {
    identity = { ...identity, detail: `${identity.detail}（initialize 与 about_me 两处同值）` };
  } else if (primary && meResult.ok) {
    identity = { ...identity, detail: `${identity.detail}（about_me 没有给出身份，未作判定主源）` };
  } else if (!primary && secondary) {
    identity = {
      ...identity,
      detail: `${identity.detail} about_me 自报 instanceId=${secondary.instanceId}，但 initialize 未声明，不能相互印证。`,
    };
  }
  if (identity.verdict !== "verified") {
    console.info(`[entity] ${key} @ ${server}: instanceId=${identity.instanceId ?? "(未声明)"} expected=${identity.expected ?? "(无)"} verdict=${identity.verdict}`);
  }

  const payload: EntityResponse = {
    server,
    workspace: scope,
    type,
    key: text(entity.key) || key,
    typeLabel: text(metadata.description),
    name: text(entity.name) || text(fields.name),
    state,
    revision: typeof entity.revision === "number" ? entity.revision : 0,
    fields,
    hiddenFields,
    properties: Array.isArray(metadata.fields) ? metadata.fields : [],
    lifecycle: metadata.lifecycle ?? null,
    roles,
    writableFields: writableFieldsOf(metadata, state, roles),
    routes: availableRoutesOf(metadata, state, roles),
    linkOptions: linkOptionsOf(metadata, state, roles),
    identity,
  };
  return { payload };
}

/** The JSON body of a failure; an absent field stays absent rather than null. */
function failureBody(failure: Failure): Record<string, unknown> {
  return {
    error: failure.error,
    ...(failure.code ? { code: failure.code } : {}),
    ...(failure.expected !== undefined ? { expected: failure.expected } : {}),
    ...(failure.actual !== undefined ? { actual: failure.actual } : {}),
    ...(failure.candidates ? { candidates: failure.candidates } : {}),
  };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const resolved = await resolveTarget(url.searchParams);
  if (!("target" in resolved)) {
    return NextResponse.json(failureBody(resolved), { status: resolved.status });
  }

  const loaded = await loadEntity(resolved);
  if (!("payload" in loaded)) return NextResponse.json(failureBody(loaded), { status: loaded.status });
  return NextResponse.json(loaded.payload);
}

/**
 * Saves fields, or takes one transition.
 *
 * Both carry the revision the panel read, so a stale form loses loudly instead
 * of overwriting someone else's change. A transition may also carry the values
 * its destination requires — the panel collects them rather than sending the
 * user back to the conversation (`FM-SUBMIT` ①③).
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const resolved = await resolveTarget(url.searchParams);
  if (!("target" in resolved)) {
    return NextResponse.json(failureBody(resolved), { status: resolved.status });
  }

  let body: { fields?: unknown; expectedRevision?: unknown; targetState?: unknown; idempotencyKey?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  }

  const targetState = typeof body.targetState === "string" ? body.targetState : null;
  const fields = asRecord(body.fields) ?? {};
  // A transition needs no fields of its own: most routes ask for nothing, and
  // the ones that do are collected by the panel. Only a save with neither a
  // destination nor a change is meaningless.
  if (!targetState && Object.keys(fields).length === 0) {
    return NextResponse.json({ error: "没有要保存的字段" }, { status: 400 });
  }

  const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
  const call = targetState ? "promotion" : "update";
  const result = await callMcpTool(resolved.target, call, {
    id: resolved.key,
    ...(targetState ? { targetState } : {}),
    // `update` requires fields; `promotion` accepts them only when the route needs them.
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    // The caller owns the key: only it can tell a retry from a new intention
    // (FM-SUBMIT ④). Generating one here made every retry a fresh submission,
    // which for `create` meant a second entity.
    idempotencyKey: acceptedKey(body.idempotencyKey, () => `panel-${resolved.key}-${Date.now()}`),
  });

  if (!result.ok) {
    // The panel must say "someone else changed it", not "save failed": the fix
    // differs (reload and re-apply vs try again).
    const conflict = /CONCURRENT_WRITE_CONFLICT|concurrent/i.test(result.error);
    return NextResponse.json({ error: result.error, conflict }, { status: conflict ? 409 : 502 });
  }

  // The write answers with the entity as it now stands (`promotion` and
  // `update` both re-read it server-side, with this caller's field permissions),
  // so that answer — not the snapshot `resolveTarget` took before writing — is
  // what the panel renders. Using `resolved` unchanged here answered every
  // transition with the pre-transition state and revision, so the panel kept
  // showing the old routes and the next save carried a stale `expectedRevision`
  // into the base's CAS (`DEFECT-000085`). A write that answers without an
  // entity (an idempotent replay) falls through to one fresh `get`.
  const written = unwrapEntity(result.value);
  const reloaded = await loadEntity({ ...resolved, entity: written ?? undefined });
  if (!("payload" in reloaded)) return NextResponse.json(failureBody(reloaded), { status: reloaded.status });
  return NextResponse.json(reloaded.payload);
}
