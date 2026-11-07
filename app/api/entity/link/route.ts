import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { callMcpTool, resolveMcpTarget, type McpHttpTarget } from "@/lib/mcp-call";
import { asRecord } from "@/lib/entity-permissions";
import { KEY_PATTERN, MAX_LINK_KEYS } from "@/lib/entity-links";

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

/** The base wants `[A-Za-z0-9_\-:.]{8,128}`; keys may hold other characters, so they are flattened. */
function idempotencyKey(prefix: string, parts: string[]): string {
  const stamp = Date.now().toString(36);
  const body = parts.join("-").replace(/[^A-Za-z0-9_\-:.]/g, "-");
  return `${prefix}-${body}-${stamp}`.slice(0, 128);
}

/**
 * The revision after a write, read back from the base.
 *
 * Linking and unlinking both bump the **downstream** entity's revision — a
 * link is part of that entity's history, not of its upstream's. A panel that
 * kept its old revision would lose its next field save to a conflict, so the
 * new number comes back with every relation write.
 */
async function readRevision(target: McpHttpTarget, key: string): Promise<number> {
  const result = await callMcpTool(target, "get", { id: key, includeAttachments: false });
  if (!result.ok) return 0;
  const entity = unwrapEntity(result.value);
  return typeof entity?.revision === "number" ? entity.revision : 0;
}

function failure(error: string): Response {
  // "Someone else changed it" is not "the link failed": the fix differs.
  const conflict = /CONCURRENT_WRITE_CONFLICT|concurrent/i.test(error);
  return NextResponse.json({ error, conflict }, { status: conflict ? 409 : 502 });
}

/**
 * Links this entity to one or more upstream entities, in one transaction.
 *
 * The batch is the base's own: `targetIds` creates every link or none, and the
 * downstream entity's revision moves once. That is why the panel validates
 * first and why a failure here must be reported as "nothing was linked"
 * rather than as a partial success.
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });

  let body: { sourceKey?: unknown; linkType?: unknown; targetKeys?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  }

  const sourceKey = text(body.sourceKey);
  const linkType = text(body.linkType);
  const targetKeys = Array.isArray(body.targetKeys)
    ? body.targetKeys.filter((key): key is string => typeof key === "string").map((key) => key.trim()).filter(Boolean)
    : [];

  if (!sourceKey) return NextResponse.json({ error: "缺少 sourceKey" }, { status: 400 });
  if (!linkType) return NextResponse.json({ error: "缺少 linkType" }, { status: 400 });
  if (targetKeys.length === 0) return NextResponse.json({ error: "没有要挂的 key" }, { status: 400 });
  if (targetKeys.length > MAX_LINK_KEYS) {
    return NextResponse.json({ error: `一次最多挂 ${MAX_LINK_KEYS} 条` }, { status: 400 });
  }
  const bad = targetKeys.find((key) => !KEY_PATTERN.test(key));
  if (bad) return NextResponse.json({ error: `key 不合法：${bad}` }, { status: 400 });

  const resolved = resolveMcpTarget(getAgentDir(), cwd, server);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const target: McpHttpTarget = resolved.target;

  const linked = await callMcpTool(target, "link", {
    sourceId: sourceKey,
    targetIds: targetKeys,
    linkType,
    idempotencyKey: idempotencyKey("panel-link", [sourceKey, linkType, ...targetKeys]),
  });
  if (!linked.ok) return failure(linked.error);

  return NextResponse.json({ revision: await readRevision(target, sourceKey), linked: targetKeys });
}

/**
 * Removes one link.
 *
 * `source` is the downstream end, which is not always the entity on screen: a
 * downstream row's link belongs to the other entity, and only that side may
 * remove it. The caller says which end is which; `self` names the entity whose
 * revision the panel needs back.
 */
export async function DELETE(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  const source = url.searchParams.get("source");
  const targetKey = url.searchParams.get("target");
  const linkType = url.searchParams.get("linkType");
  const self = url.searchParams.get("self") ?? source;

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });
  if (!source) return NextResponse.json({ error: "缺少 source" }, { status: 400 });
  if (!targetKey) return NextResponse.json({ error: "缺少 target" }, { status: 400 });
  if (!linkType) return NextResponse.json({ error: "缺少 linkType" }, { status: 400 });
  if (!KEY_PATTERN.test(source) || !KEY_PATTERN.test(targetKey)) {
    return NextResponse.json({ error: "key 不合法" }, { status: 400 });
  }

  const resolved = resolveMcpTarget(getAgentDir(), cwd, server);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const target: McpHttpTarget = resolved.target;

  const removed = await callMcpTool(target, "unlink", {
    sourceId: source,
    targetId: targetKey,
    linkType,
    idempotencyKey: idempotencyKey("panel-unlink", [source, targetKey, linkType]),
  });
  if (!removed.ok) return failure(removed.error);

  return NextResponse.json({ revision: await readRevision(target, self ?? source) });
}
