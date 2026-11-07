import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { callMcpTool, resolveMcpTarget, type McpHttpTarget } from "@/lib/mcp-call";
import { asRecord, asStrings } from "@/lib/entity-permissions";
import { evaluateLinkKeys, KEY_PATTERN, MAX_LINK_KEYS, type LinkKeyCheck } from "@/lib/entity-links";
import { normalizeTraces } from "@/lib/entity-traces";

export const dynamic = "force-dynamic";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function unwrapEntity(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.key === "string") return record;
  const inner = asRecord(record.entity);
  return typeof inner?.key === "string" ? inner : null;
}

/** The relation as this type declares it; a name nobody declares is not a relation. */
function traceDefinition(metadata: unknown, linkType: string): Record<string, unknown> | null {
  const definition = asRecord(metadata);
  const declared = Array.isArray(definition?.traceability) ? definition.traceability : [];
  for (const entry of declared) {
    const trace = asRecord(entry);
    if (typeof trace?.name === "string" && trace.name.toLowerCase() === linkType.toLowerCase()) return trace;
  }
  return null;
}

/** `key in ['A','B']` — every element has passed `KEY_PATTERN`, so quoting is safe. */
function keysQuery(keys: string[]): string {
  return `key in [${keys.map((key) => `'${key}'`).join(", ")}]`;
}

/**
 * Judges a batch of typed keys before anything is written.
 *
 * Reads the entity the links would start from, its type definition (which
 * names the upstream types and the states a relation accepts), the entities
 * that actually exist under those keys, and the links already active — then
 * says one thing per key. The panel shows that verdict, so a wrong key costs
 * one request instead of a failed write.
 *
 * Nothing is written here.
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });

  let body: { sourceKey?: unknown; linkType?: unknown; keys?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  }

  const sourceKey = text(body.sourceKey);
  const linkType = text(body.linkType);
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === "string" && key.trim() !== "").map((key) => key.trim())
    : [];

  if (!sourceKey) return NextResponse.json({ error: "缺少 sourceKey" }, { status: 400 });
  if (!linkType) return NextResponse.json({ error: "缺少 linkType" }, { status: 400 });
  if (keys.length === 0) return NextResponse.json({ items: [] satisfies LinkKeyCheck[] });
  if (keys.length > MAX_LINK_KEYS * 2) {
    return NextResponse.json({ error: `一次最多校验 ${MAX_LINK_KEYS * 2} 个 key` }, { status: 400 });
  }

  const resolved = resolveMcpTarget(getAgentDir(), cwd, server);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const target: McpHttpTarget = resolved.target;

  const entityResult = await callMcpTool(target, "get", { id: sourceKey, includeAttachments: false });
  if (!entityResult.ok) return NextResponse.json({ error: entityResult.error }, { status: 502 });
  const entity = unwrapEntity(entityResult.value);
  if (!entity) return NextResponse.json({ error: `服务器没有返回 ${sourceKey}` }, { status: 502 });

  const sourceType = text(entity.type);
  // The space is part of the question: a key only means something inside one.
  const workspace = text(entity.workspaceId);

  const [metadataResult, linksResult] = await Promise.all([
    callMcpTool(target, "get_metadata", { type: sourceType }),
    callMcpTool(target, "list_traces", { entityId: sourceKey }),
  ]);

  if (!metadataResult.ok) return NextResponse.json({ error: metadataResult.error }, { status: 502 });
  const trace = traceDefinition(metadataResult.value, linkType);
  if (!trace) {
    return NextResponse.json(
      { error: `${sourceType} 没有声明关系 ${linkType}` },
      { status: 400 },
    );
  }

  // Two spellings of one key: `key in […]` is case-sensitive, and a pasted
  // lowercase key should not look like a missing entity.
  const lookUp = [...new Set(
    keys.filter((key) => KEY_PATTERN.test(key)).flatMap((key) => [key, key.toUpperCase()]),
  )];
  let listed: unknown[] = [];
  if (lookUp.length > 0 && workspace) {
    const listResult = await callMcpTool(target, "list", {
      workspaceId: workspace,
      query: keysQuery(lookUp),
      limit: 100,
    });
    if (!listResult.ok) return NextResponse.json({ error: listResult.error }, { status: 502 });
    const payload = asRecord(listResult.value);
    listed = Array.isArray(payload?.items) ? payload.items : [];
  }

  const found = listed.flatMap((entry) => {
    const record = asRecord(entry);
    const key = text(record?.key);
    if (!key) return [];
    return [{
      key,
      type: text(record?.type),
      name: text(record?.name),
      state: text(record?.state),
    }];
  });

  const traces = normalizeTraces(
    linksResult.ok && Array.isArray(linksResult.value) ? linksResult.value : [],
    sourceKey,
  );
  const linkedKeys = traces.upstream
    .filter((row) => row.linkType.toLowerCase() === linkType.toLowerCase())
    .map((row) => row.key);

  return NextResponse.json({
    items: evaluateLinkKeys({
      keys,
      sourceKey,
      targetTypes: asStrings(trace.targetEntityTypes),
      allowedTargetStates: asStrings(trace.allowedTargetStates),
      found,
      linkedKeys,
    }),
  });
}
