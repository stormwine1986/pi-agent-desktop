import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { callMcpTool, resolveMcpTarget } from "@/lib/mcp-call";

export const dynamic = "force-dynamic";

/** The entity on the other end of one link, as much of it as a list row needs. */
export interface RelationRow {
  key: string;
  type: string;
  name: string;
  state: string;
  /** `targets`, `is_targeted_by`, `verifies`… as the base names it. */
  linkType: string;
}

export interface TracesResponse {
  upstream: RelationRow[];
  downstream: RelationRow[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rowOf(entity: Record<string, unknown> | undefined, link: Record<string, unknown>): RelationRow | null {
  const key = text(entity?.key);
  if (!key) return null;
  return {
    key,
    type: text(entity?.type),
    name: text(entity?.name),
    state: text(entity?.state),
    linkType: text(link.linkType),
  };
}

/**
 * What this entity is traced to, one hop out, split by direction.
 *
 * The base reports each link with both ends embedded; the row worth showing is
 * the end that is *not* this entity. Direction is the base's own reading —
 * "downstream" means the other entity depends on this one — so upstream and
 * downstream are never inferred from link type names, which a customer's model
 * is free to extend.
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

  const result = await callMcpTool(resolved.target, "list_traces", { entityId: key });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });

  const links = Array.isArray(result.value) ? result.value : [];
  const response: TracesResponse = { upstream: [], downstream: [] };
  for (const entry of links) {
    const link = asRecord(entry);
    if (!link || link.isActive === false) continue;
    const source = asRecord(link.sourceEntity);
    const target = asRecord(link.targetEntity);
    // The other end is whichever entity is not this one; a self-link is dropped.
    const other = text(source?.key) === key ? target : source;
    const row = rowOf(other, link);
    if (!row || row.key === key) continue;
    if (text(link.direction) === "upstream") response.upstream.push(row);
    else if (text(link.direction) === "downstream") response.downstream.push(row);
  }

  return NextResponse.json(response);
}
