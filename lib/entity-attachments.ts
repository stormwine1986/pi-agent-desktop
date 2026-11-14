/**
 * Entity attachments in the panel: what the base returned, how it is grouped,
 * and whether this reader may write each category in the entity's state.
 *
 * The base owns the semantics (`SSR-000101`): a category declares its own
 * permissions and an absent declaration **falls back** (category → type →
 * entity) instead of denying. That fallback is why this file exists — reading
 * "分类没写权限" as "拒绝" would lock every existing attachment the moment a
 * category is added.
 *
 * Nothing here filters by read permission. The base already answers only what
 * this reader may read (`get` / `list_attachments` are filtered by the same
 * predicate as REST), and a second predicate in the panel would create exactly
 * the two-lists bypass `SSR-000101` ③ forbids. An empty result therefore means
 * "nothing readable", never "nothing matched a filter of ours".
 *
 * Also here: building the REST URLs from the configured entry (`SSR-000100`) —
 * the content URL for a download, and the two-step upload pair (blob, then
 * bind). Content never travels through a tool call (`AR-000008` ②).
 *
 * Upload rules and the pre-flight check are here too, because they are the
 * *type's* declaration applied to one file: what the picker may offer, what it
 * must refuse before sending, and which categories the panel shows an entry
 * for (`SSR-000126` ⑤).
 */

import { asRecord, asStrings } from "./entity-permissions";

/** One attachment as the base reports it in `get.attachments` / `list_attachments`. */
export interface EntityAttachment {
  id: string;
  category: string;
  fileName: string;
  fileSize: number | null;
  contentType: string;
  description: string;
  sha256: string;
  /** The entity revision the attachment was bound at. */
  sourceRevision: number | null;
  /** Upload time: `validFrom` (when it became effective) or `createdAt`. */
  uploadedAt: string;
  contentUrl: string;
}

/** One category, with this reader's write verdict for the entity's current state. */
export interface AttachmentCategoryView {
  key: string;
  label: string;
  /** Whether the type definition declares it (an unlisted category renders, but declares no policy). */
  declared: boolean;
  multiple: boolean;
  contentTypes: string[];
  maxSizeMb: number | null;
  /**
   * Why this reader could not add attachments of this category right now:
   * `state` is the model freezing the category in this state (`write: { X: [] }`),
   * `role` is this reader lacking the write role. `null` means writable.
   */
  blockedBy: "state" | "role" | null;
  /**
   * Whether the panel offers an upload entry for it.
   *
   * Declared categories do, and so does the implicit `default` of a type that
   * declares none (`SSR-000101` AC-3). A category that only *appears* in the
   * data — bound before the model declared it — does not: the base would refuse
   * a new binding of an undeclared category, and an entry that always fails is
   * worse than no entry (`SSR-000126` ⑤).
   */
  uploadable: boolean;
}

/** A category group as the panel renders it: declared order, then anything else. */
export interface AttachmentGroup {
  key: string;
  label: string;
  category: AttachmentCategoryView;
  rows: EntityAttachment[];
}

type WritePolicy = string[] | Record<string, string[]> | null;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A category's write policy, in either declared shape (a list, or a map by state). */
function writePolicyOf(value: unknown): WritePolicy {
  if (Array.isArray(value)) return asStrings(value);
  const record = asRecord(value);
  if (!record) return null;
  const byState: Record<string, string[]> = {};
  for (const [state, roles] of Object.entries(record)) {
    if (Array.isArray(roles)) byState[state] = asStrings(roles);
  }
  return byState;
}

/** The label an undeclared category falls back to (implicit `default`, `SSR-000101` AC-3). */
export function attachmentCategoryLabel(key: string): string {
  return key === "default" ? "默认附件" : key;
}

/**
 * The type definition's attachment block, as declared.
 *
 * A type that declares nothing still has the implicit `default` category,
 * which is exactly what the base stores for older data — so the panel never
 * invents a second taxonomy.
 */
export function attachmentDeclarationOf(metadata: unknown): {
  typeWrite: WritePolicy;
  categories: Array<{
    key: string;
    label: string;
    multiple: boolean;
    contentTypes: string[];
    maxSizeMb: number | null;
    write: WritePolicy;
  }>;
} {
  const definition = asRecord(metadata);
  const block = asRecord(definition?.attachments);
  const permissions = asRecord(block?.permissions);
  const typeWrite = writePolicyOf(permissions?.write);

  const declared = Array.isArray(block?.categories) ? block?.categories : [];
  const categories: Array<{
    key: string;
    label: string;
    multiple: boolean;
    contentTypes: string[];
    maxSizeMb: number | null;
    write: WritePolicy;
  }> = [];
  for (const entry of declared) {
    const category = asRecord(entry);
    const key = text(category?.key);
    if (!key) continue;
    categories.push({
      key,
      label: text(category?.label) || attachmentCategoryLabel(key),
      multiple: category?.multiple !== false,
      contentTypes: asStrings(category?.contentTypes),
      maxSizeMb: numberOrNull(category?.maxSizeMb),
      write: writePolicyOf(asRecord(category?.permissions)?.write),
    });
  }
  return { typeWrite, categories };
}

/** The rows the base returned, normalized: unknown shapes are dropped, never guessed at. */
export function normalizeAttachments(value: unknown): EntityAttachment[] {
  if (!Array.isArray(value)) return [];
  const rows: EntityAttachment[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const id = text(record?.id);
    if (!id) continue;
    rows.push({
      id,
      category: text(record?.category) || "default",
      fileName: text(record?.fileName) || id,
      fileSize: numberOrNull(record?.fileSize),
      contentType: text(record?.contentType) || "application/octet-stream",
      description: text(record?.description),
      sha256: text(record?.sha256),
      sourceRevision: numberOrNull(record?.sourceRevision),
      uploadedAt: text(record?.validFrom) || text(record?.createdAt),
      contentUrl: text(record?.contentUrl),
    });
  }
  return rows;
}

/** A rule decided for this state, or "no opinion" so the next level may answer. */
function stateRule(policy: WritePolicy, state: string): string[] | null {
  if (Array.isArray(policy)) return policy;
  if (!policy) return null;
  if (!Object.prototype.hasOwnProperty.call(policy, state)) return null;
  return policy[state] ?? null;
}

function roleAllowed(list: string[], roles: string[]): boolean {
  if (list.includes("*")) return true;
  const held = new Set(roles.map((role) => role.toUpperCase()));
  return list.some((role) => held.has(role.toUpperCase()));
}

/**
 * Whether a category can be written in this state — and if not, whose rule said
 * so.
 *
 * The order is `SSR-000101`'s, and each step is a *fallback*, not an override:
 * category state entry → category list → type state entry → type list → the
 * entity's own write answer. A declared empty list is a decision (frozen),
 * never a fall-through — otherwise a state could never lock a category.
 */
export function categoryWriteBlock(input: {
  categoryWrite: WritePolicy;
  typeWrite: WritePolicy;
  state: string;
  roles: string[];
  entityWritable: boolean;
}): "state" | "role" | null {
  const fromCategory = stateRule(input.categoryWrite, input.state);
  const decided = fromCategory ?? stateRule(input.typeWrite, input.state);
  if (decided === null) {
    // Nothing declared anywhere: the entity-level answer is the last word.
    return input.entityWritable ? null : "role";
  }
  if (decided.length === 0) return "state";
  return roleAllowed(decided, input.roles) ? null : "role";
}

/**
 * Every category the panel can show, in declaration order.
 *
 * `present` are the category keys that actually appear in the attachment list:
 * a category bound before the model declared it (or a legacy `default`) still
 * gets a group, labelled from the model where possible.
 */
export function attachmentCategoriesView(input: {
  metadata: unknown;
  state: string;
  roles: string[];
  /** `writableFieldsOf(...).length > 0` — the entity-level fallback. */
  entityWritable: boolean;
  present?: string[];
}): AttachmentCategoryView[] {
  const declaration = attachmentDeclarationOf(input.metadata);
  const views: AttachmentCategoryView[] = declaration.categories.map((category) => ({
    key: category.key,
    label: category.label,
    declared: true,
    multiple: category.multiple,
    contentTypes: category.contentTypes,
    maxSizeMb: category.maxSizeMb,
    uploadable: true,
    blockedBy: categoryWriteBlock({
      categoryWrite: category.write,
      typeWrite: declaration.typeWrite,
      state: input.state,
      roles: input.roles,
      entityWritable: input.entityWritable,
    }),
  }));

  // A type that declares no categories still has the implicit `default`, which
  // is what the base stores for its data. Adding it here is what gives such a
  // type an upload entry at all (`SSR-000126` AC-2); without a declaration there
  // is no category policy to freeze, so the type-level block answers, and the
  // entity-level answer after it (`SSR-000101` AC-3).
  if (views.length === 0) {
    views.push({
      key: "default",
      label: attachmentCategoryLabel("default"),
      declared: false,
      multiple: true,
      contentTypes: [],
      maxSizeMb: null,
      uploadable: true,
      blockedBy: categoryWriteBlock({
        categoryWrite: null,
        typeWrite: declaration.typeWrite,
        state: input.state,
        roles: input.roles,
        entityWritable: input.entityWritable,
      }),
    });
  }

  const known = new Set(views.map((view) => view.key));
  for (const key of input.present ?? []) {
    if (!key || known.has(key)) continue;
    known.add(key);
    views.push({
      key,
      label: attachmentCategoryLabel(key),
      declared: false,
      multiple: true,
      contentTypes: [],
      maxSizeMb: null,
      uploadable: false,
      blockedBy: null,
    });
  }
  return views;
}

/**
 * Groups the rows the base returned.
 *
 * Only groups with something in them are emitted: an empty declared category is
 * not a section, and an entity with no attachments at all says「暂无附件」
 * instead of drawing an empty table (`SSR-000126` AC-1).
 */
export function attachmentGroups(
  attachments: EntityAttachment[],
  categories: AttachmentCategoryView[],
): AttachmentGroup[] {
  const groups: AttachmentGroup[] = [];
  const byCategory = new Map<string, EntityAttachment[]>();
  for (const row of attachments) {
    const bucket = byCategory.get(row.category);
    if (bucket) bucket.push(row);
    else byCategory.set(row.category, [row]);
  }

  const ordered = [...categories];
  const known = new Set(ordered.map((category) => category.key));
  for (const key of byCategory.keys()) {
    if (known.has(key)) continue;
    known.add(key);
    ordered.push({
      key,
      label: attachmentCategoryLabel(key),
      declared: false,
      multiple: true,
      contentTypes: [],
      maxSizeMb: null,
      uploadable: false,
      blockedBy: null,
    });
  }

  for (const category of ordered) {
    const rows = byCategory.get(category.key) ?? [];
    if (rows.length === 0) continue;
    // Newest first: the last thing bound is the thing being looked for.
    const sorted = [...rows].sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : a.uploadedAt > b.uploadedAt ? -1 : 0));
    groups.push({ key: category.key, label: category.label, category, rows: sorted });
  }
  return groups;
}

/**
 * The REST root of the configured entry, plus one of the base's own fixed paths.
 *
 * `apiUrl` is the entry's MCP endpoint (`…/entity/mcp`) and the REST mount is
 * that URL minus its trailing `/mcp` — so every path built here is
 * `entry + fixed suffix`, never something the caller chose. That is the whole
 * security property of these proxies: the entry's credential can only ever be
 * sent to the entry's own server (`AR-000008` ④).
 */
function entityRestUrl(
  apiUrl: string,
  relativePath: string,
  query?: Record<string, string>,
): URL | null {
  let api: URL;
  try {
    api = new URL(apiUrl);
  } catch {
    return null;
  }
  const root = api.pathname.replace(/\/+$/, "").replace(/\/mcp$/i, "");
  const path = `${root}/${relativePath.replace(/^\/+/, "")}`.replace(/\/{2,}/g, "/");
  let url: URL;
  try {
    url = new URL(`${api.origin}${path}`);
  } catch {
    return null;
  }
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  return url;
}

/**
 * The REST URL of one attachment's content on the same configured entry.
 *
 * `contentUrl` is the base's own relative path (`/entity/attachments/{id}/content`)
 * and `apiUrl` is the entry's MCP endpoint (`…/entity/mcp`), so the API root is
 * that path minus its trailing `/mcp`. Deriving the name from the **entry**
 * (never from the reply) is what keeps the download on the same credentials and
 * the same permission system as the read that listed it (`AR-000008` ④).
 */
export function attachmentContentUrl(input: {
  apiUrl: string;
  contentUrl: string;
  revision?: number | null;
  asOf?: string | null;
}): string | null {
  let api: URL;
  try {
    api = new URL(input.apiUrl);
  } catch {
    return null;
  }
  const raw = input.contentUrl.trim();
  if (!raw) return null;

  const root = api.pathname.replace(/\/+$/, "").replace(/\/mcp$/i, "");
  let path: string;
  if (raw.startsWith("/")) {
    path = root && raw.startsWith(`${root}/`) ? raw : root && raw.startsWith("/entity/") ? root + raw.slice("/entity".length) : raw;
  } else {
    path = `${root}/${raw}`;
  }

  let url: URL;
  try {
    url = new URL(`${api.origin}${path}`);
  } catch {
    return null;
  }
  if (typeof input.revision === "number" && input.revision > 0) {
    url.searchParams.set("revision", String(input.revision));
  } else if (input.asOf) {
    url.searchParams.set("asOf", input.asOf);
  }
  return url.toString();
}

/**
 * `Content-Disposition` for a saved attachment: the base's own header carries a
 * mangled ASCII fallback, so the panel sets the name it listed instead (and
 * keeps an ASCII fallback for clients that ignore `filename*`).
 */
export function attachmentDisposition(fileName: string): string {
  const clean = fileName.replace(/[\r\n"\\]/g, " ").trim() || "attachment";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_") || "attachment";
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A file's size as the panel reads it. */
export function formatAttachmentSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "未知大小";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A download failure as the panel and the route both state it. */
export interface AttachmentFailure {
  error: string;
  code: string;
  statusCode: number;
  retriable: boolean;
  /** The base's own English message, kept for attribution, never the only explanation. */
  detail?: string;
}

/**
 * One sentence a person can act on, per the base's error contract
 * (`code` / `statusCode` / `retriable`, `SSR-000100` AC-6).
 *
 * The base's own `message` is English and names ids; it is kept in `code` and
 * `detail` for attribution, never shown as the only explanation.
 */
export function attachmentFailure(status: number, body: unknown): AttachmentFailure {
  const record = asRecord(body) ?? {};
  const code = text(record.code) || (status === 403 ? "PERMISSION_DENIED" : status === 404 ? "ATTACHMENT_NOT_FOUND" : `HTTP_${status}`);
  const retriable = typeof record.retriable === "boolean" ? record.retriable : status === 503 || status === 429 || status >= 500;
  const detail = text(record.message);

  let error: string;
  if (code === "PERMISSION_DENIED" || status === 403) {
    error = "没有权限查看这个附件（403）。权限按附件分类判定：列表里看不到的分类，直接下载同样会被拒。";
  } else if (code === "ATTACHMENT_NOT_FOUND" || (status === 404 && code !== "ENTITY_NOT_FOUND")) {
    error = "附件不存在，或已被删除（404）。用修订号或时点可以看到它还在时的版本。";
  } else if (code === "ENTITY_NOT_FOUND") {
    error = "这条实体在当前环境里不存在（404）。";
  } else if (code === "ATTACHMENT_STORAGE_UNAVAILABLE" || status === 503) {
    error = "附件存储暂时不可用（503），过一会儿可以重试。";
  } else if (code === "ATTACHMENT_TOO_LARGE" || status === 413) {
    error = "这个附件超过分类的大小上限（413），取不回来。";
  } else if (status === 416) {
    error = "请求的字节范围超出文件大小（416）。";
  } else if (status === 401) {
    error = "这个 server 的凭证没有通过认证（401），检查 mcp.json 里的 Authorization。";
  } else if (status >= 500) {
    error = `服务器取附件时出错（${status}），${retriable ? "可以稍后重试" : "需要人工检查"}。`;
  } else {
    error = `下载失败（${status}）${detail ? `：${detail}` : ""}`;
  }

  return {
    error,
    code,
    statusCode: typeof record.statusCode === "number" ? record.statusCode : status,
    retriable,
    ...(detail ? { detail } : {}),
  };
}

/**
 * The view parameters a panel read carries (`revision` / `asOf`), validated.
 *
 * `null` means "current"; a view the panel cannot honour (negative revision, an
 * unparseable time, both at once) is refused rather than silently dropped — a
 * dropped view would show current content under a history banner.
 */
export function parseAttachmentView(search: {
  get(name: string): string | null;
}): { revision: number | null; asOf: string | null } | { error: string } {
  const revisionText = search.get("revision")?.trim() ?? "";
  const asOfText = search.get("asOf")?.trim() ?? "";
  if (revisionText && asOfText) return { error: "revision 与 asOf 只能选一个" };

  let revision: number | null = null;
  if (revisionText) {
    if (!/^\d+$/.test(revisionText) || Number(revisionText) <= 0) {
      return { error: `revision 必须是正整数：${revisionText}` };
    }
    revision = Number(revisionText);
  }
  let asOf: string | null = null;
  if (asOfText) {
    const when = Date.parse(asOfText);
    if (Number.isNaN(when)) return { error: `asOf 不是合法时间：${asOfText}` };
    asOf = new Date(when).toISOString();
  }
  return { revision, asOf };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 上传（`SSR-000126` ⑤）：两步式通道的第一步与第二步
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What a category's entry does for this reader right now.
 *
 * `role` never renders an entry at all (`SSR-000126` AC-3: 无写权 → 不给入口);
 * `state` renders it disabled with 「当前状态只读」; `multiple` renders it
 * disabled with the reason, because the base allows one active binding only and
 * a click that can only fail is not an entry.
 */
export type AttachmentUploadBlock = "role" | "state" | "multiple";

/** One upload entry: a category the type declares, plus why it is (un)usable. */
export interface AttachmentUploadEntry {
  category: AttachmentCategoryView;
  blocked: AttachmentUploadBlock | null;
  /** Active rows already bound in this category — the `multiple: false` reason. */
  activeCount: number;
}

/**
 * The upload entries the panel renders, in declaration order.
 *
 * Every declared category gets one, including the ones with no attachment yet
 * (`SSR-000126` AC-2) — otherwise "this type takes an evidence file" would only
 * become visible after someone had already uploaded one.
 */
export function attachmentUploadEntries(input: {
  categories: AttachmentCategoryView[];
  attachments: EntityAttachment[];
}): AttachmentUploadEntry[] {
  const counts = new Map<string, number>();
  for (const row of input.attachments) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);

  const entries: AttachmentUploadEntry[] = [];
  for (const category of input.categories) {
    if (!category.uploadable) continue;
    const activeCount = counts.get(category.key) ?? 0;
    const blocked: AttachmentUploadBlock | null =
      category.blockedBy !== null
        ? category.blockedBy
        : !category.multiple && activeCount > 0
          ? "multiple"
          : null;
    entries.push({ category, blocked, activeCount });
  }
  return entries;
}

/** The base's own syntax for a category key (`attachment-category.ts`). */
export const ATTACHMENT_CATEGORY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/**
 * A key as one URL path segment. The same characters `lib/entity-links.ts`
 * accepts — a key never holds a slash, so it can never address another path.
 */
export const ATTACHMENT_ENTITY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** `blob_` + the base's generated id. */
export const ATTACHMENT_BLOB_ID_PATTERN = /^blob_[A-Za-z0-9_-]{1,80}$/;

/** Step one: where content is stored (`POST /entity/blobs?category=…`). */
export function attachmentBlobUrl(input: {
  apiUrl: string;
  category: string;
  fileName?: string;
}): string | null {
  if (!ATTACHMENT_CATEGORY_PATTERN.test(input.category)) return null;
  const query: Record<string, string> = { category: input.category };
  // The base reads `?fileName=` before the raw-bytes name header, and a query
  // parameter survives non-ASCII names that a header would mangle.
  if (input.fileName) query.fileName = input.fileName;
  return entityRestUrl(input.apiUrl, "blobs", query)?.toString() ?? null;
}

/** Step two: where the stored blob is bound to the entity. */
export function attachmentBindUrl(input: { apiUrl: string; entityKey: string }): string | null {
  if (!ATTACHMENT_ENTITY_KEY_PATTERN.test(input.entityKey)) return null;
  return entityRestUrl(input.apiUrl, `entities/${encodeURIComponent(input.entityKey)}/attachments`)?.toString() ?? null;
}

/**
 * Whether a declared MIME list accepts one content type.
 *
 * Mirrors the base's own comparison (`attachment-service.ts`): `*​/*` accepts
 * everything, `type/*` accepts the family, and an exact type also matches its
 * parameters (`application/pdf; charset=…`). Kept identical so the client never
 * refuses a file the base would take.
 */
export function attachmentContentTypeAccepted(contentTypes: string[], contentType: string): boolean {
  if (contentTypes.length === 0) return true;
  const actual = (contentType || "application/octet-stream").toLowerCase().trim();
  return contentTypes.some((allowed) => {
    const normalized = allowed.toLowerCase().trim();
    if (normalized === "*/*") return true;
    if (normalized.endsWith("/*")) return actual.startsWith(normalized.slice(0, normalized.length - 1));
    return actual === normalized || actual.startsWith(`${normalized};`);
  });
}

/** 「允许的类型 / 上限」in the words the reader needs before picking a file. */
export function attachmentUploadRules(category: Pick<AttachmentCategoryView, "contentTypes" | "maxSizeMb">): string {
  const parts: string[] = [];
  if (category.contentTypes.length > 0) parts.push(`类型 ${category.contentTypes.join(" / ")}`);
  if (category.maxSizeMb !== null) parts.push(`上限 ${formatAttachmentSize(Math.floor(category.maxSizeMb * 1024 * 1024))}`);
  return parts.length > 0 ? parts.join("，") : "不限类型与大小";
}

/**
 * The pre-flight check the panel runs before it sends anything
 * (`SSR-000126` AC-4).
 *
 * Two rules, both from the type declaration:
 * - **size**: a declared `maxSizeMb` is enforced here. A `null` one is *not* a
 *   licence to invent a limit — the base's global cap (`attachments.limits`)
 *   applies and is never hard-coded in the panel; its 413 arrives readable.
 * - **content type**: a declared `contentTypes` list is enforced here. When the
 *   browser reports no type (`file.type === ""`, e.g. an unknown extension)
 *   there is nothing to compare, so the check passes and the base's 415 speaks
 *   instead of a guess about what the file "probably" is.
 */
export function attachmentUploadPrecheck(input: {
  contentTypes: string[];
  maxSizeMb: number | null;
  fileName: string;
  contentType: string;
  fileSize: number;
}): { ok: true } | { ok: false; error: string } {
  if (input.fileSize === 0) {
    return { ok: false, error: `「${input.fileName}」是空文件，基座不接受空内容，没有发出请求。` };
  }
  if (input.maxSizeMb !== null) {
    const limit = Math.floor(input.maxSizeMb * 1024 * 1024);
    if (input.fileSize > limit) {
      return {
        ok: false,
        error: `「${input.fileName}」有 ${formatAttachmentSize(input.fileSize)}，超过这个分类的上限 `
          + `${formatAttachmentSize(limit)}（${input.maxSizeMb} MB），没有发出请求。`,
      };
    }
  }
  if (input.contentType && !attachmentContentTypeAccepted(input.contentTypes, input.contentType)) {
    return {
      ok: false,
      error: `「${input.fileName}」是 ${input.contentType}，这个分类只收 `
        + `${input.contentTypes.join(" / ")}，没有发出请求。`,
    };
  }
  return { ok: true };
}

/** Which half of the two-step channel a failure belongs to. */
export type AttachmentUploadStep = "content" | "bind";

/** The label the panel and the proxy both use for a step. */
export function attachmentUploadStepLabel(step: AttachmentUploadStep): string {
  return step === "content" ? "传内容" : "绑定";
}

/** An upload failure, stating which step failed and what the base said. */
export interface AttachmentUploadFailure extends AttachmentFailure {
  step: AttachmentUploadStep;
}

/**
 * One sentence a person can act on, per step.
 *
 * Same error contract as the download (`code` / `statusCode` / `retriable`,
 * `SSR-000100` AC-6), but the wording has to name the step: "403" at the blob
 * means this identity cannot store content at all, while a 403 at bind means
 * this category is frozen here or the role is missing — and only the second one
 * is worth retrying after a role/state change.
 */
export function attachmentUploadFailure(
  step: AttachmentUploadStep,
  status: number,
  body: unknown,
): AttachmentUploadFailure {
  const record = asRecord(body) ?? {};
  const code = text(record.code)
    || (status === 403 ? "PERMISSION_DENIED"
      : status === 404 ? "ATTACHMENT_NOT_FOUND"
        : status === 413 ? "ATTACHMENT_TOO_LARGE"
          : status === 415 ? "ATTACHMENT_CATEGORY_CONTENT_TYPE_UNSUPPORTED"
            : `HTTP_${status}`);
  const retriable = typeof record.retriable === "boolean"
    ? record.retriable
    : status === 503 || status === 429 || status >= 500;
  const detail = text(record.message);
  const accepted = asStrings(record.acceptedContentTypes);
  const supported = asStrings(record.supportedCategories);
  const limitBytes = typeof record.limitBytes === "number" ? record.limitBytes : null;

  let error: string;
  if (status === 401 || code === "ATTACHMENT_UNAUTHORIZED") {
    error = "这个 server 的凭证没有通过认证（401），检查 mcp.json 里的 Authorization。";
  } else if (code === "PERMISSION_DENIED" || status === 403) {
    error = step === "bind"
      ? "这个分类在当前状态或你的角色下不可写（403）。状态冻结时改状态，角色不足时找管理员。"
      : "这个身份不能上传附件内容（403），角色里缺少写附件的权限。";
  } else if (code === "ATTACHMENT_TOO_LARGE" || status === 413) {
    error = `文件超过上限（413${limitBytes ? `：${formatAttachmentSize(limitBytes)}` : ""}），没有上传。`;
  } else if (code === "ATTACHMENT_CATEGORY_CONTENT_TYPE_UNSUPPORTED" || status === 415) {
    error = `这个分类不接受该内容类型（415）${accepted.length > 0 ? `，允许 ${accepted.join(" / ")}` : ""}。`;
  } else if (code === "ATTACHMENT_CATEGORY_UNSUPPORTED") {
    error = `这个类型没有声明该分类（400）${supported.length > 0 ? `，允许 ${supported.join(" / ")}` : ""}。`;
  } else if (code === "ATTACHMENT_STORAGE_UNAVAILABLE" || status === 503) {
    error = "附件存储暂时不可用（503），过一会儿可以重试。";
  } else if (status === 409) {
    error = "实体刚被别人改过（409），列表已不是最新；刷新后再传一次即可。";
  } else if (code === "ENTITY_NOT_FOUND" || status === 404) {
    error = "实体或刚上传的内容已经找不到了（404），重新选文件再试。";
  } else if (status >= 500) {
    error = `服务器在处理这一步时出错（${status}），${retriable ? "可以稍后重试" : "需要人工检查"}。`;
  } else {
    error = `${attachmentUploadStepLabel(step)}失败（${status}）${detail ? `：${detail}` : ""}`;
  }

  return {
    step,
    error,
    code,
    statusCode: typeof record.statusCode === "number" ? record.statusCode : status,
    retriable,
    ...(detail ? { detail } : {}),
  };
}
