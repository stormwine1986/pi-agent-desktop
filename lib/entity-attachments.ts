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
 * Also here: building the REST content URL from the configured entry
 * (`SSR-000100`). Content never travels through a tool call (`AR-000008` ②).
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
   * `role` is this reader lacking the write role. `null` means writable — but
   * the panel still renders no write entry this round (read-only scope).
   */
  blockedBy: "state" | "role" | null;
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
    blockedBy: categoryWriteBlock({
      categoryWrite: category.write,
      typeWrite: declaration.typeWrite,
      state: input.state,
      roles: input.roles,
      entityWritable: input.entityWritable,
    }),
  }));

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
