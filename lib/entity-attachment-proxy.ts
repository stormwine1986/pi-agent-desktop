/**
 * Resolving the server entry an attachment request must go through.
 *
 * Shared by the download proxy and by the two-step upload proxies so all three
 * agree on one thing: the target comes from `mcp.json` (project entry, then
 * global), never from the request. Only `cwd` and the entry's *name* are
 * caller-chosen, which is why none of these routes can be pointed at a
 * destination the caller picked (`AR-000008` ④).
 */

import { NextResponse } from "next/server";

import { agentDir } from "./agent-dir";
import { resolveMcpTarget, type McpHttpTarget } from "./mcp-call";

export type ProxyTargetResult =
  | { ok: true; target: McpHttpTarget }
  | { ok: false; response: NextResponse };

export function resolveProxyTarget(cwd: string | null, server: string | null): ProxyTargetResult {
  if (!cwd) {
    return { ok: false, response: NextResponse.json({ error: "cwd is required" }, { status: 400 }) };
  }
  if (!server) {
    return { ok: false, response: NextResponse.json({ error: "server is required" }, { status: 400 }) };
  }
  const resolved = resolveMcpTarget(agentDir(), cwd, server);
  if (!resolved.ok) {
    return {
      ok: false,
      // `503`: the entry exists in the panel's mind but this app cannot reach it,
      // which is a wiring fault rather than the caller's mistake.
      response: NextResponse.json(
        { error: resolved.error, code: "channel", statusCode: 400, retriable: false },
        { status: 400 },
      ),
    };
  }
  return { ok: true, target: resolved.target };
}

/**
 * The base's error body, whatever shape it arrived in (`code` / `statusCode` /
 * `retriable` when it sent one; a truncated message otherwise).
 */
export async function readErrorBody(response: Response): Promise<unknown> {
  const raw = await response.text().catch(() => "");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw.slice(0, 200) };
  }
}
