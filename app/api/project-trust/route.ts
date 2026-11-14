import { NextResponse } from "next/server";
import { agentDir as resolveAgentDir } from "@/lib/agent-dir";
import type {
  McpErrorResponse,
  McpRefusalReason,
  ProjectMcpListing,
  ProjectTrustResponse,
  ProjectTrustStatus,
  ProjectTrustUnreadableResponse,
} from "@/lib/api-types";
import { readProjectMcpServers } from "@/lib/mcp-config-read";
import { isMcpEntryRefusal, validateMcpProject } from "@/lib/mcp-entry-request";
import { invalidateModelsCache } from "@/lib/models-cache";
import { getProjectTrustStatus, trustProject } from "@/lib/project-trust";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { destroyRpcSessionsForCwd, hasBusyRpcSessionForCwd } from "@/lib/session-registry";

export const dynamic = "force-dynamic";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refusal(status: number, reason: McpRefusalReason, error: string) {
  return NextResponse.json({ error, reason } satisfies McpErrorResponse, { status });
}

/**
 * The folder, checked as Settings › MCP's routes check theirs
 * (`validateMcpProject()`): absolute, inside the allowed roots as given, then
 * a directory. A relative path is refused rather than resolved against the
 * server process's own folder, and a folder outside the roots gets 403
 * whether or not it exists.
 */
async function validateCwd(value: unknown): Promise<
  { cwd: string; allowedRoots: Set<string> } | { response: NextResponse }
> {
  const result = await validateMcpProject(value);
  if (isMcpEntryRefusal(result)) return { response: NextResponse.json(result.body, { status: result.status }) };
  return result;
}

async function listProjectMcpServers(agentDir: string, cwd: string, allowedRoots: Set<string>): Promise<ProjectMcpListing> {
  try {
    const { file, servers } = await readProjectMcpServers({ agentDir, cwd, allowedRoots });
    return { mcpFile: file, mcpServers: servers };
  } catch (error) {
    return { mcpServers: [], mcpError: errorMessage(error) };
  }
}

// GET /api/project-trust?cwd=<folder>: the trust status, and the servers the
// project's `.pi/mcp.json` declares, so the trust dialog lists what trusting
// would connect before anyone trusts the folder (ADR 0006). The listing reads
// the files only, like GET /api/mcp: no server is spawned, no value resolved,
// no `!command` run, and env and header values never leave the server.
//
// `?servers=0` answers the status alone, and the first screen asks that way:
// the shell uses nothing but the status, while building the listing loads the
// pi SDK's module graph (`readProjectMcpServers()` → `loadPiSdkInternals()` →
// `import(dist/index.js)`), which blocks the loop for 3.0–4.9 s in the packaged
// Node (TASK-000213). The dialog fetches the full answer when it opens, so
// nothing is lost — only deferred to the request that reads it.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const result = await validateCwd(params.get("cwd"));
  if ("response" in result) return result.response;
  const agentDir = resolveAgentDir();
  // Listed whatever the trust store says: the listing does not depend on it,
  // and a dialog left without one would offer Trust with nothing listed.
  const statusOnly = params.get("servers") === "0";
  const listing = statusOnly ? {} : await listProjectMcpServers(agentDir, result.cwd, result.allowedRoots);
  try {
    return NextResponse.json({
      ...getProjectTrustStatus(result.cwd, agentDir),
      ...listing,
    } satisfies ProjectTrustResponse | ProjectTrustStatus);
  } catch (error) {
    // trust.json unparsable, or locked by another process (the pi CLI) past the
    // store's short wait; trusting would fail the same way right now.
    return NextResponse.json(
      { error: errorMessage(error), reason: "trust-unreadable", ...listing } satisfies
        | ProjectTrustUnreadableResponse
        | { error: string; reason: "trust-unreadable" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return refusal(403, "request-denied", "Untrusted API request");
  if (!hasJsonContentType(req)) return refusal(415, "content-type", "Content-Type must be application/json");
  try {
    // A body that is not JSON names no cwd.
    const body = await req.json().catch(() => null) as { cwd?: unknown } | null;
    const result = await validateCwd(body?.cwd);
    if ("response" in result) return result.response;

    const agentDir = resolveAgentDir();
    const current = getProjectTrustStatus(result.cwd, agentDir);
    if (!current.requiresTrust) {
      return refusal(409, "trust-not-required", "This project has no resources that require trust");
    }
    if (hasBusyRpcSessionForCwd(result.cwd)) {
      return refusal(409, "session-busy", "Wait for the active session to finish before trusting this project");
    }

    const status = trustProject(result.cwd, agentDir);
    invalidateModelsCache();
    await destroyRpcSessionsForCwd(result.cwd);
    return NextResponse.json(status);
  } catch (error) {
    return refusal(500, "internal", errorMessage(error));
  }
}
