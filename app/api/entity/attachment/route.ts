import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveMcpTarget } from "@/lib/mcp-call";
import {
  attachmentContentUrl,
  attachmentDisposition,
  attachmentFailure,
  parseAttachmentView,
} from "@/lib/entity-attachments";

export const dynamic = "force-dynamic";

/**
 * One attachment's bytes, from the REST channel — the only channel that carries
 * content (`AR-000008` ②).
 *
 * The panel cannot call the base directly: the browser holds no credential, and
 * the credential belongs to the *server entry* (`mcp.json`'s `Authorization`),
 * not to the browser session. So this route resolves the same entry the panel
 * read through, asks the base's own REST endpoint with that entry's headers, and
 * streams the answer back. It is a proxy, nothing more:
 *
 * - no second permission check — the base applies one predicate to the list and
 *   the download (`SSR-000101` ③), and a local predicate would be the bypass;
 * - no byte handling of its own — `ETag`, `Range`, `If-None-Match` are passed
 *   through so a resumed download is the base's business (`SSR-000100` AC-4);
 * - the URL is built from the **entry + attachment id**, never from a URL the
 *   client supplies: a caller-chosen URL would send the entry's credential
 *   somewhere else.
 */
const ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{1,80}$/;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  const attachmentId = (url.searchParams.get("attachmentId") ?? url.searchParams.get("id") ?? "").trim();
  const fileName = (url.searchParams.get("name") ?? "").trim();
  const inline = url.searchParams.get("inline") === "1";

  if (!cwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!server) return NextResponse.json({ error: "server is required" }, { status: 400 });
  if (!ATTACHMENT_ID.test(attachmentId)) {
    return NextResponse.json({ error: `attachmentId 不合法：${attachmentId || "(空)"}` }, { status: 400 });
  }

  const view = parseAttachmentView(url.searchParams);
  if ("error" in view) return NextResponse.json({ error: view.error }, { status: 400 });

  const resolved = resolveMcpTarget(getAgentDir(), cwd, server);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error, code: "channel", statusCode: 400, retriable: false }, { status: 400 });
  }
  const target = resolved.target;
  // The base's documented content path under the same mount the entry names
  // (`SSR-000100`): `${apiRoot}/attachments/{id}/content`.
  const upstream = attachmentContentUrl({
    apiUrl: target.url,
    contentUrl: `attachments/${attachmentId}/content`,
    revision: view.revision,
    asOf: view.asOf,
  });
  if (!upstream) {
    return NextResponse.json({ error: `server "${target.name}" 的地址不能用来取附件`, code: "channel", statusCode: 400, retriable: false }, { status: 400 });
  }

  const headers: Record<string, string> = { ...target.headers };
  // Passing the conditional/partial-read headers through is what makes a
  // retried download resume instead of restarting (`SSR-000100` AC-4).
  for (const name of ["range", "if-none-match", "if-range"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }

  let response: Response;
  try {
    response = await fetch(upstream, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), cache: "no-store" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return NextResponse.json(
      { error: `连不上 ${target.name} 取附件：${message}`, code: "channel", statusCode: 502, retriable: true },
      { status: 502 },
    );
  }

  if (response.status === 304) {
    return new Response(null, {
      status: 304,
      headers: {
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag") as string } : {}),
        "cache-control": "no-store",
      },
    });
  }

  if (!response.ok) {
    // The base's error contract (`code`/`statusCode`/`retriable`) is what the
    // panel turns into a sentence; a bare 500 or an empty body would leave it
    // guessing (`SSR-000100` AC-6).
    const raw = await response.text().catch(() => "");
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw ? { message: raw.slice(0, 200) } : null;
    }
    const failure = attachmentFailure(response.status, body);
    return NextResponse.json(failure, { status: response.status });
  }

  const outgoing: Record<string, string> = {
    "content-type": response.headers.get("content-type") ?? "application/octet-stream",
    // Already gated by the entry's own credential; a shared cache must not keep
    // the bytes.
    "cache-control": "no-store",
    "content-disposition": attachmentDisposition(fileName || attachmentId),
  };
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = response.headers.get(name);
    if (value) outgoing[name] = value;
  }
  if (inline) {
    outgoing["content-disposition"] = outgoing["content-disposition"].replace(/^attachment;/, "inline;");
  }

  return new Response(response.body, { status: response.status, headers: outgoing });
}
