import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { callMcpTool, resolveMcpTarget } from "@/lib/mcp-call";

export const dynamic = "force-dynamic";

/** A type this workspace would accept a new entity of. */
export interface CreatableType {
  type: string;
  canCreate: boolean;
  /** Fields the base insists on at creation, in its own order. */
  requiredFields: string[];
  initialState: string;
}

export interface TypesResponse {
  workspace: string;
  types: CreatableType[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Which types may be created here.
 *
 * The base answers this per workspace — without one it reports nothing as
 * creatable, because "where" is part of the question. That is why the panel
 * asks with the space its current list belongs to instead of keeping a type
 * menu of its own.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  const workspace = url.searchParams.get("workspace");

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });
  if (!workspace) return NextResponse.json({ error: "workspace is required" }, { status: 400 });

  const resolved = resolveMcpTarget(getAgentDir(), cwd, server);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const result = await callMcpTool(resolved.target, "list_types", { workspaceId: workspace });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });

  const payload = asRecord(result.value) ?? {};
  const listed = Array.isArray(payload.types) ? payload.types : [];
  const types: CreatableType[] = listed.flatMap((entry) => {
    const record = asRecord(entry);
    const type = text(record?.type);
    if (!type) return [];
    return [{
      type,
      canCreate: record?.canCreate === true,
      requiredFields: Array.isArray(record?.requiredFields)
        ? record.requiredFields.filter((name): name is string => typeof name === "string")
        : [],
      initialState: text(record?.initialState),
    }];
  });

  const response: TypesResponse = { workspace, types };
  return NextResponse.json(response);
}
