import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { callMcpTool, resolveMcpTarget, type McpHttpTarget } from "@/lib/mcp-call";
import { globalMcpConfigPath, projectMcpConfigPath } from "@/lib/mcp-config-read";
import { asRecord, asStrings, availableRoutesOf, linkOptionsOf, rolesIn, writableFieldsOf, type AvailableRoute, type LinkOption } from "@/lib/entity-permissions";
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
  workspace: string | null;
  key: string;
}

/**
 * A failed read. `code` is what the panel needs to say the right thing:
 * `channel` is wiring (`mcp.json`), the other two are the entity or its type
 * not arriving — only there does "元数据不齐，表单不渲染" (FM-META ①) apply.
 */
interface Failure {
  error: string;
  status: number;
  code?: "channel" | "entity" | "metadata";
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
  /** The entity the server answered with, which is what names its space. */
  entity?: Record<string, unknown>;
  error?: string;
}

/**
 * Works out which server answers for this key.
 *
 * A link written by a conversation names its channel; a key the reader clicked
 * as plain text does not, so the servers this project declares are asked in
 * turn and the first one holding the entity wins. The entity carries its own
 * workspace, so only the server has to be guessed.
 *
 * A named channel this project does not configure is a hint, not a demand.
 * Every person's `.pi/mcp.json` names its own endpoint (`entity-demo-system-`
 * `alice` / `-bob` / `-evan`), and the same stack is often configured under a
 * third name (`entity-base`), so a reply carried from one project into another
 * used to be unopenable even though this project could read the entity per-
 * fectly well. The named server still goes first when it exists, and the space
 * a link carries breaks ties between identical keys on different stacks.
 */
async function pickTarget(
  cwd: string,
  key: string,
  server: string | null,
  workspace: string | null,
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

  const attempts = await Promise.all(ordered.map(async (name): Promise<Attempt> => {
    const resolved = resolveMcpTarget(agentDir, cwd, name);
    if (!resolved.ok) return { name, error: resolved.error };
    const found = await callMcpTool(resolved.target, "get", { id: key, includeAttachments: false });
    const entity = found.ok ? unwrapEntity(found.value) : null;
    return entity
      ? { name, target: resolved.target, entity }
      : { name, error: found.ok ? "没有这条实体" : found.error };
  }));

  const hits = attempts.filter((attempt) => attempt.target !== undefined);
  // The space disambiguates identical keys: the demo stack and the test stack
  // hold the same kinds of keys, and a link says which one it means.
  const scoped = workspace
    ? hits.filter((attempt) => text(attempt.entity?.workspaceId) === workspace)
    : [];
  // One hit is the answer even when the link's space disagrees (a stale or
  // mistyped space is not a reason to withhold the only entity there is); two
  // hits with no matching space are a question the caller has to answer.
  const hit = scoped[0] ?? (hits.length === 1 ? hits[0] : undefined);
  if (hit?.target) {
    return {
      target: hit.target,
      server: hit.name,
      workspace: text(hit.entity?.workspaceId) || workspace,
      key,
    };
  }

  const named = server ? attempts.find((attempt) => sameMcpServer(attempt.name, server)) : undefined;
  if (named) return { error: named.error ?? `服务器 ${named.name} 没有这条实体`, status: 502, code: "entity" };

  if (hits.length > 1) {
    const spaces = hits.map((attempt) => text(attempt.entity?.workspaceId) || attempt.name);
    return {
      error: `${hits.length} 个 server 都认得 ${key}（${spaces.join("、")}），链接里的空间${workspace ? ` ${workspace}` : ""}不在其中，无法确定打开哪一个`,
      status: 409,
      code: "channel",
    };
  }

  const missing = server
    ? `这个项目没有名为 "${server}" 的 server（已配置：${names.join("、")}），`
    : "";
  return {
    error: `${missing}也没有哪个 server 认得 ${key}。链接里的 server 是写它的那个项目的 mcp.json 名字，改成本项目的名字、或回到那个项目打开。`,
    status: 404,
    code: "channel",
  };
}

function resolveTarget(search: URLSearchParams): Promise<Target | Failure> | Target | Failure {
  const cwd = search.get("cwd");
  const server = search.get("server");
  const workspace = search.get("workspace");
  const key = search.get("key");

  if (!cwd) return { error: "cwd is required", status: 400 };
  if (!key) return { error: "key is required", status: 400 };

  const resolved = server ? resolveMcpTarget(getAgentDir(), cwd, server) : null;
  if (!resolved?.ok || !server) return pickTarget(cwd, key, server, workspace);
  // The configured spelling: a link carries pi's namespace (`a_b`) for a server
  // `mcp.json` names `a-b`, and every follow-up request should name the real entry.
  return { target: resolved.target, server: resolved.target.name, workspace, key };
}

/** Reads the entity, its type definition and this reader's roles in one go. */
async function loadEntity(target: McpHttpTarget, server: string, workspace: string | null, key: string) {
  // `get` rejects a `workspaceId` (it answers nothing), so it is not passed; the
  // entity reports its own.
  const entityResult = await callMcpTool(target, "get", { id: key, includeAttachments: false });
  if (!entityResult.ok) return { error: entityResult.error, code: "entity" as const };

  const entity = unwrapEntity(entityResult.value);
  if (!entity) return { error: "服务器没有返回这条实体", code: "entity" as const };

  const type = text(entity.type);
  if (!type) return { error: "无法确定实体类型", code: "entity" as const };
  // The entity's own space wins over the one the link claims: a stale or foreign
  // link must not relabel a readable entity into the wrong space, which would
  // also judge this reader's roles against a space it holds nothing in.
  const scope = text(entity.workspaceId) || workspace || "";

  const [metadataResult, meResult] = await Promise.all([
    callMcpTool(target, "get_metadata", { type }),
    callMcpTool(target, "about_me", {}),
  ]);
  // The type definition is what the form is built from, so this is the one
  // failure the panel explains as "元数据不齐" (FM-META ①).
  if (!metadataResult.ok) return { error: metadataResult.error, code: "metadata" as const };

  const metadata = asRecord(metadataResult.value) ?? {};
  const fields = asRecord(entity.fields) ?? {};
  const hiddenFields = asStrings(entity.hiddenFields);
  const state = text(entity.state) || text(fields.state);
  const roles = meResult.ok ? rolesIn(meResult.value, scope) : [];

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
  };
  return { payload };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const resolved = await resolveTarget(url.searchParams);
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
  }

  const loaded = await loadEntity(resolved.target, resolved.server, resolved.workspace, resolved.key);
  if ("error" in loaded) return NextResponse.json({ error: loaded.error, code: loaded.code }, { status: 502 });
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
  if ("error" in resolved) {
    return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
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

  const reloaded = await loadEntity(resolved.target, resolved.server, resolved.workspace, resolved.key);
  if ("error" in reloaded) return NextResponse.json({ error: reloaded.error, code: reloaded.code }, { status: 502 });
  return NextResponse.json(reloaded.payload);
}
