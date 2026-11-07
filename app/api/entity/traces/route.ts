import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { callMcpTool, resolveMcpTarget, type McpHttpTarget } from "@/lib/mcp-call";
import { asRecord, canManageTraceOf, rolesIn } from "@/lib/entity-permissions";
import { normalizeTraces, type TracesResponse } from "@/lib/entity-traces";

export const dynamic = "force-dynamic";

export type { RelationRow, TracesResponse } from "@/lib/entity-traces";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `get` answers a flat entity or wraps it under `entity`; accept both. */
function unwrapEntity(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.key === "string") return record;
  const inner = asRecord(record.entity);
  return typeof inner?.key === "string" ? inner : null;
}

/**
 * One hop of traceability, with the one thing a list row needs beyond the
 * link: whether this reader may remove it.
 *
 * Removing a link is the downstream side's call (`unlink` takes `sourceId`),
 * so the question differs by direction: for an upstream row the source is this
 * entity, for a downstream row it is the other one — whose type definition
 * decides the answer.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  const key = url.searchParams.get("key");

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });

  const resolved = resolveMcpTarget(getAgentDir(), cwd, server);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const target: McpHttpTarget = resolved.target;

  const entityResult = await callMcpTool(target, "get", { id: key, includeAttachments: false });
  if (!entityResult.ok) return NextResponse.json({ error: entityResult.error }, { status: 502 });
  const entity = unwrapEntity(entityResult.value);
  if (!entity) return NextResponse.json({ error: `服务器没有返回 ${key}` }, { status: 502 });

  const type = text(entity.type);
  const workspace = text(entity.workspaceId);

  const [linksResult, metadataResult, meResult] = await Promise.all([
    callMcpTool(target, "list_traces", { entityId: key }),
    callMcpTool(target, "get_metadata", { type }),
    callMcpTool(target, "about_me", {}),
  ]);

  if (!linksResult.ok) {
    // A failed read must say so: an empty list would read as "no relations".
    return NextResponse.json({ error: linksResult.error, upstream: [], downstream: [] }, { status: 502 });
  }

  const traces: TracesResponse = normalizeTraces(
    Array.isArray(linksResult.value) ? linksResult.value : [],
    key,
  );
  const roles = meResult.ok ? rolesIn(meResult.value, workspace) : [];

  // One definition per type involved, so each row's own type decides its permission.
  const definitions = new Map<string, unknown>();
  if (metadataResult.ok) definitions.set(type, metadataResult.value);
  const otherTypes = [...new Set(
    traces.downstream.map((row) => row.type).filter((name) => name && name !== type),
  )];
  const extra = await Promise.all(otherTypes.map(async (other) => {
    const found = await callMcpTool(target, "get_metadata", { type: other });
    return [other, found.ok ? found.value : null] as const;
  }));
  for (const [name, definition] of extra) definitions.set(name, definition);

  for (const row of [...traces.upstream, ...traces.downstream]) {
    // The link's owner is the source side: this entity going upstream, the
    // other entity going downstream.
    const ownerType = row.direction === "upstream" ? type : row.type;
    row.canUnlink = canManageTraceOf(definitions.get(ownerType), row.linkType, roles, { allowRetired: true });
  }

  return NextResponse.json(traces);
}
