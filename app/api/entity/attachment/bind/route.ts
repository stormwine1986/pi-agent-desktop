import { NextResponse } from "next/server";

import {
  ATTACHMENT_BLOB_ID_PATTERN,
  ATTACHMENT_CATEGORY_PATTERN,
  ATTACHMENT_ENTITY_KEY_PATTERN,
  attachmentBindUrl,
  attachmentUploadFailure,
} from "@/lib/entity-attachments";
import { readErrorBody, resolveProxyTarget } from "@/lib/entity-attachment-proxy";

export const dynamic = "force-dynamic";

/**
 * Step two: bind the stored blob to the entity, which produces the new revision
 * (`SSR-000126` AC-5).
 *
 * Split from the content step on purpose: a failure has to say whether the bytes
 * never arrived or the binding was refused, and the base's answers differ
 * (401/413/415/503 at the blob; 403/404/409 at the bind). Same proxy rules as
 * the download: the target is `entry + /entities/{key}/attachments`, the key is
 * one path segment that cannot leave it, and the entry's credential never
 * travels to a caller-chosen host.
 *
 * `expectedRevision` is deliberately not sent: an upload carries no field
 * values, so there is nothing a concurrent change could be overwritten with —
 * passing the revision this panel read would only turn "someone else moved the
 * entity meanwhile" into a failed upload. The entity's new revision comes back
 * in the answer and the panel re-reads.
 */
const BIND_TIMEOUT_MS = 30_000;
const MAX_FILE_NAME = 255;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_\-:.]{8,128}$/;

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const server = url.searchParams.get("server");
  const key = (url.searchParams.get("key") ?? "").trim();

  if (!ATTACHMENT_ENTITY_KEY_PATTERN.test(key)) {
    return NextResponse.json(
      { error: `key 不合法：${key || "(空)"}`, code: "key", statusCode: 400, retriable: false, step: "bind" },
      { status: 400 },
    );
  }

  let body: { blobId?: unknown; category?: unknown; fileName?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json(
      { error: "请求体不是 JSON", code: "body", statusCode: 400, retriable: false, step: "bind" },
      { status: 400 },
    );
  }

  const blobId = typeof body.blobId === "string" ? body.blobId.trim() : "";
  const category = (typeof body.category === "string" ? body.category.trim() : "") || "default";
  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";

  if (!ATTACHMENT_BLOB_ID_PATTERN.test(blobId)) {
    return NextResponse.json(
      { error: `blobId 不合法：${blobId || "(空)"}`, code: "blobId", statusCode: 400, retriable: false, step: "bind" },
      { status: 400 },
    );
  }
  if (!ATTACHMENT_CATEGORY_PATTERN.test(category)) {
    return NextResponse.json(
      { error: `category 不合法：${category}`, code: "category", statusCode: 400, retriable: false, step: "bind" },
      { status: 400 },
    );
  }
  if (fileName.length > MAX_FILE_NAME) {
    return NextResponse.json(
      { error: `文件名超过 ${MAX_FILE_NAME} 个字符`, code: "fileName", statusCode: 400, retriable: false, step: "bind" },
      { status: 400 },
    );
  }

  const resolved = resolveProxyTarget(cwd, server);
  if (!resolved.ok) return resolved.response;
  const target = resolved.target;

  const upstream = attachmentBindUrl({ apiUrl: target.url, entityKey: key });
  if (!upstream) {
    return NextResponse.json(
      { error: `server "${target.name}" 的地址不能用来绑定附件`, code: "channel", statusCode: 400, retriable: false, step: "bind" },
      { status: 400 },
    );
  }

  const headers: Record<string, string> = {
    ...target.headers,
    "content-type": "application/json",
  };
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey && IDEMPOTENCY_KEY.test(idempotencyKey)) headers["idempotency-key"] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(upstream, {
      method: "POST",
      headers,
      body: JSON.stringify({
        blobId,
        category,
        // Omitted rather than blank: a blank name is a 400, "no name" keeps the
        // uploaded one (the base's own rule, DEFECT-000098).
        ...(fileName ? { fileName } : {}),
      }),
      signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return NextResponse.json(
      { error: `连不上 ${target.name} 绑定附件：${message}`, code: "channel", statusCode: 502, retriable: true, step: "bind" },
      { status: 502 },
    );
  }

  const upstreamBody = response.ok
    ? await response.json().catch(() => null) as Record<string, unknown> | null
    : await readErrorBody(response);

  if (!response.ok) {
    const failure = attachmentUploadFailure("bind", response.status, upstreamBody);
    return NextResponse.json(failure, { status: response.status });
  }

  const record = (upstreamBody ?? {}) as Record<string, unknown>;
  const attachment = typeof record.attachment === "object" && record.attachment !== null
    ? record.attachment as Record<string, unknown>
    : null;
  if (!attachment) {
    return NextResponse.json(
      { error: `${target.name} 没有返回绑定结果`, code: "channel", statusCode: 502, retriable: true, step: "bind" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    step: "bind",
    attachment,
    entityRevision: typeof record.entityRevision === "number" ? record.entityRevision : null,
    // An identical (blobId, entity, category) binding already existed: the base
    // returns the existing attachment instead of creating a second one.
    replayed: record.replayed === true,
    // 201 for a new binding, 200 for an idempotent replay of the same one.
  }, { status: response.status });
}
