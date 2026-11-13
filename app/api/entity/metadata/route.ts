import { NextResponse } from "next/server";
import { agentDir } from "@/lib/agent-dir";
import { callMcpTool, resolveMcpTarget } from "@/lib/mcp-call";

export const dynamic = "force-dynamic";

/**
 * One type's definition, without an entity behind it.
 *
 * Creating needs the form a type describes before any entity exists, so this
 * answers `get_metadata` alone — the same data the detail view renders from, so
 * a new entity is asked for exactly the fields the type declares.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  const type = url.searchParams.get("type");

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });
  if (!type) return NextResponse.json({ error: "type is required" }, { status: 400 });

  const resolved = resolveMcpTarget(agentDir(), cwd, server);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const result = await callMcpTool(resolved.target, "get_metadata", { type });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });

  const metadata = typeof result.value === "object" && result.value !== null
    ? result.value as Record<string, unknown>
    : {};
  return NextResponse.json({
    type,
    typeLabel: typeof metadata.description === "string" ? metadata.description : "",
    properties: Array.isArray(metadata.fields) ? metadata.fields : [],
    requiredOnCreate: Array.isArray((metadata.validityRules as Record<string, unknown> | undefined)?.requiredOnCreate)
      ? (metadata.validityRules as Record<string, unknown>).requiredOnCreate
      : [],
  });
}
