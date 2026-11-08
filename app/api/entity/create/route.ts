import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { callMcpTool, resolveMcpTarget } from "@/lib/mcp-call";
import { acceptedKey } from "@/lib/idempotency";

export const dynamic = "force-dynamic";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Creates one entity in the workspace the caller named.
 *
 * The space is a required part of the request on purpose: the same key prefix
 * exists in several spaces, and "create" without one is a question the base
 * refuses to answer. Fields are passed through untouched — the base decides
 * what is acceptable, and the panel shows what it said (`FM-VALIDATE` ③).
 */
export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  const workspace = url.searchParams.get("workspace");

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });
  if (!workspace) return NextResponse.json({ error: "workspace is required" }, { status: 400 });

  let body: { type?: unknown; fields?: unknown; idempotencyKey?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "请求体不是 JSON" }, { status: 400 });
  }

  const type = text(body.type);
  const raw = asRecord(body.fields) ?? {};
  // A state cannot be created into: the type decides where an entity starts and
  // routes move it. Dropping it here keeps a form bug from becoming a base error.
  const fields = Object.fromEntries(Object.entries(raw).filter(([name]) => name !== "state"));
  if (!type) return NextResponse.json({ error: "缺少类型" }, { status: 400 });

  const resolved = resolveMcpTarget(getAgentDir(), cwd, server);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const created = await callMcpTool(resolved.target, "create", {
    workspaceId: workspace,
    type,
    fields,
    // Creating has no revision to lose a race on, so a retry after a lost
    // response is the one place a duplicated entity can appear. The key comes
    // from the caller, which knows whether this is that retry (FM-SUBMIT ④).
    idempotencyKey: acceptedKey(body.idempotencyKey, () => `panel-create-${type}-${Date.now()}`),
  });

  if (!created.ok) return NextResponse.json({ error: created.error }, { status: 502 });

  const entity = asRecord(created.value);
  const key = text(entity?.key) || text(asRecord(entity?.entity)?.key);
  if (!key) {
    // A replayed submission: the base already applied it and answers with only
    // `_idempotency` — no entity to open. Reporting "it worked, look it up" is
    // the truth; calling it a failure would send the user to create it again.
    const replayed = asRecord(entity?._idempotency)?.replayed === true;
    return replayed
      ? NextResponse.json({ replayed: true, error: "这次提交在先前的尝试里已经创建成功，请在列表里查看。" })
      : NextResponse.json({ error: "服务器没有返回新实体的 key" }, { status: 502 });
  }
  return NextResponse.json({ key, type, state: text(entity?.state), workspace });
}
