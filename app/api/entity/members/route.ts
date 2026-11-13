import { NextResponse } from "next/server";
import { agentDir } from "@/lib/agent-dir";
import { callMcpTool, resolveMcpTarget } from "@/lib/mcp-call";
import { normalizeMembers, type WorkspaceMember } from "@/lib/entity-members";

export const dynamic = "force-dynamic";

export interface MembersResponse {
  workspace: string;
  members: WorkspaceMember[];
}

/**
 * The candidate list for `user` fields (`SSR-000093` ②).
 *
 * One source, one call: `list_workspace_members` on the configured channel. The
 * panel must not derive candidates from `get_metadata` (the type says `user`,
 * nothing about who) and must not keep a list of its own — the base is the only
 * party that knows who may hold the value, so a menu we invented would offer
 * names the write would then reject.
 *
 * A failure is reported, not swallowed: the panel answers it by degrading to a
 * text field with a visible note (`SSR-000093` ⑦), which is only honest if it
 * can tell "could not read" from "nobody is a member".
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  const workspace = url.searchParams.get("workspace");

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });
  if (!workspace) return NextResponse.json({ error: "workspace is required" }, { status: 400 });

  const resolved = resolveMcpTarget(agentDir(), cwd, server);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const result = await callMcpTool(resolved.target, "list_workspace_members", { workspaceId: workspace });
  // An older deployment has no such tool, a token may lack the right, the channel
  // may be down. All three are "the list is unavailable", and the panel degrades
  // the same way for each — the reason still travels so the note can explain it.
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: "members-unavailable" },
      { status: 502 },
    );
  }

  const response: MembersResponse = { workspace, members: normalizeMembers(result.value) };
  return NextResponse.json(response);
}
