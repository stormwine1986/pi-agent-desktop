import { NextResponse } from "next/server";

import {
  ATTACHMENT_CATEGORY_PATTERN,
  attachmentBlobUrl,
  attachmentUploadFailure,
} from "@/lib/entity-attachments";
import { readErrorBody, resolveProxyTarget } from "@/lib/entity-attachment-proxy";

export const dynamic = "force-dynamic";

/**
 * Step one of the upload channel: store the content, get a `blobId`
 * (`SSR-000126` AC-5, `SSR-000100` AC-3).
 *
 * The browser holds no credential — it belongs to the *server entry* — so the
 * bytes come here and this route asks the base's own REST endpoint with that
 * entry's headers. It is a proxy and nothing else:
 *
 * - the upstream URL is `entry + /blobs + ?category=`, both from the request in
 *   a fixed template — never a URL the caller supplied;
 * - no local permission check: the base decides who may store content, counting
 *   every hop the same way (a local predicate would be the second rule);
 * - no size policy of its own: a declared `maxSizeMb` was already checked in the
 *   panel, and the base's global cap answers with its own readable 413.
 *
 * The failure carries `step: "content"` so the panel can say which half of the
 * two-step channel failed instead of showing a bare status.
 */
const UPLOAD_TIMEOUT_MS = 120_000;
/** Same limit the base enforces on an attachment's display name. */
const MAX_FILE_NAME = 255;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{8,128}$/;

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  // An absent category is the implicit `default`, exactly as the base reads it.
  const category = (url.searchParams.get("category") ?? "").trim() || "default";
  const fileName = (url.searchParams.get("fileName") ?? "").trim();

  if (!ATTACHMENT_CATEGORY_PATTERN.test(category)) {
    return NextResponse.json(
      { error: `category 不合法：${category || "(空)"}`, code: "category", statusCode: 400, retriable: false, step: "content" },
      { status: 400 },
    );
  }
  if (fileName.length > MAX_FILE_NAME) {
    return NextResponse.json(
      { error: `文件名超过 ${MAX_FILE_NAME} 个字符`, code: "fileName", statusCode: 400, retriable: false, step: "content" },
      { status: 400 },
    );
  }

  const resolved = resolveProxyTarget(cwd, server);
  if (!resolved.ok) return resolved.response;
  const target = resolved.target;

  const upstream = attachmentBlobUrl({ apiUrl: target.url, category, fileName });
  if (!upstream) {
    return NextResponse.json(
      { error: `server "${target.name}" 的地址不能用来上传附件`, code: "channel", statusCode: 400, retriable: false, step: "content" },
      { status: 400 },
    );
  }

  const headers: Record<string, string> = { ...target.headers };
  // Forwarded verbatim, boundary included: the panel sends `multipart/form-data`
  // so the base sees the file's real media type and name (raw bytes are accepted
  // only as `application/octet-stream`, which would lose both). A raw caller
  // still works — the base reads its own declared limit either way.
  headers["content-type"] = request.headers.get("content-type") ?? "application/octet-stream";
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && IDEMPOTENCY_KEY.test(idempotencyKey)) headers["idempotency-key"] = idempotencyKey;

  // Buffered rather than streamed: the base can answer 413 before reading the
  // body, and a half-written stream is a far worse failure to explain than an
  // honest "we asked, it refused".
  const bytes = await request.arrayBuffer();

  let response: Response;
  try {
    response = await fetch(upstream, {
      method: "POST",
      headers,
      body: bytes.byteLength > 0 ? bytes : null,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return NextResponse.json(
      { error: `连不上 ${target.name} 传内容：${message}`, code: "channel", statusCode: 502, retriable: true, step: "content" },
      { status: 502 },
    );
  }

  const body = response.ok
    ? await response.json().catch(() => null) as Record<string, unknown> | null
    : await readErrorBody(response);

  if (!response.ok) {
    const failure = attachmentUploadFailure("content", response.status, body);
    return NextResponse.json(failure, { status: response.status });
  }

  // The base answers `{blobId, sha256, size, …}`; the panel works in the same
  // names the attachment rows use (`fileSize`), so normalize once, here.
  const record = (body ?? {}) as Record<string, unknown>;
  const blobId = typeof record.blobId === "string" ? record.blobId.trim() : "";
  if (!blobId) {
    return NextResponse.json(
      { error: `${target.name} 没有返回 blobId`, code: "channel", statusCode: 502, retriable: true, step: "content" },
      { status: 502 },
    );
  }
  const size = typeof record.fileSize === "number" ? record.fileSize : typeof record.size === "number" ? record.size : bytes.byteLength;
  return NextResponse.json({
    step: "content",
    blobId,
    sha256: typeof record.sha256 === "string" ? record.sha256 : "",
    fileSize: size,
    contentType: typeof record.contentType === "string" ? record.contentType : headers["content-type"],
    fileName: typeof record.fileName === "string" ? record.fileName : fileName,
    // Same sha256 already stored: the base reused a blob instead of writing a
    // second object. Worth telling the reader, not worth hiding.
    deduplicated: record.deduplicated === true,
    // Same status the base answered: 201 for a new blob, 200 when identical
    // content was already stored, so a caller can tell them apart.
  }, { status: response.status });
}
