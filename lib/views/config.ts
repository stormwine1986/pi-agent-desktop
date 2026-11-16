import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
// js-yaml 5 ships named exports only (no default), so import the function.
import { load as loadYaml } from "js-yaml";
import { FILL_PLACEHOLDERS, unknownPlaceholders } from "./fill";

/**
 * `.pi/views.yaml` in a workspace declares the to-do views shown in the right
 * panel. It is read on every request, so editing the file takes effect on the
 * next refresh without restarting the app.
 *
 *   views:
 *     - title: 我的审批
 *       server: entity-base            # a name from mcp.json — the data channel
 *       workspace: ws_entity_base      # `list` requires it
 *       dql: "type = 'OR' and state = 'DRAFT'"
 *       columns: [key, name, state, created_by, product_category]
 *       orderBy: modified_at           # optional
 *       order: desc                    # optional, asc | desc
 *       pageSize: 50                   # optional, 1–100
 *       notify: true                   # optional, default true: announce new entries
 *       fill:                          # optional: what an automatic park has to write
 *         remarks: "【自动】{{view}} 由派发泵写入：{{reason}}"
 *
 * Nothing here is prescriptive about which fields exist: `columns` is whatever
 * the workspace defines, and a column with no value renders empty rather than
 * failing the view.
 */
export type ViewOrder = "asc" | "desc";

/**
 * Sort keys: one field, or an ordered list of them (`SSR-000066` rev20,
 * `SSR-000055` multi-key). The list is handed to `list` verbatim — the panel
 * never sorts, so an array here is a query argument, not a local operation.
 */
export type ViewOrderBy = string | string[];

/**
 * Sort direction: one value for every key, or one per key (same length as
 * `orderBy`). A single value next to a key list applies to all of them.
 */
export type ViewOrderValue = ViewOrder | ViewOrder[];

export interface ViewDefinition {
  title: string;
  /** MCP server name from `mcp.json`. */
  server: string;
  /** Workspace id passed to `list` (the tool rejects calls without one). */
  workspace: string;
  dql: string;
  columns: string[];
  orderBy: ViewOrderBy | null;
  order: ViewOrderValue;
  pageSize: number;
  /** Whether a background re-evaluation may announce new entries for this view. */
  notify: boolean;
  /**
   * Which navigation group this view belongs to, or null when ungrouped.
   *
   * Only the navigation reads it: evaluation, paging and reminders behave the
   * same whichever group a view sits in (SSR-000087 VW-NAV ②).
   */
  group: string | null;
  /**
   * Dispatch configuration, or null for a read-only view.
   *
   * Only the shape is checked here (SSR-000066 VW-CFG). Whether the states
   * exist, whether the routes connect them and whether the directories are on
   * disk are semantic checks owned by VW-WATCH / VW-CLAIM, because they need
   * the entity type's metadata.
   */
  watch: ViewWatch | null;
}

/**
 * The three states a dispatched item passes through, named by the view's author.
 *
 * There is no "hand it back" state: an attempt that did not land goes straight
 * to `manual` and stays there until a person decides what to do with it. Retries
 * were tried and removed — the dispatcher cannot tell "the work did not happen"
 * from "the work happened but was not recorded", so the second attempt learned
 * nothing from the first and the third only burned time.
 */
export interface WatchClaim {
  /** The pending state, as written in the view's DQL. */
  from: string;
  /** Claimed: the item leaves the pending set. */
  to: string;
  /** Parked here when an attempt did not land or timed out. Never automatic again. */
  manual: string;
}

export interface ViewWatch {
  enabled: boolean;
  /** Execution project: absolute path, resolved against the project that owns views.yaml. */
  project: string;
  /** Prompt template file: absolute path. */
  prompt: string;
  intervalSec: number;
  timeoutMin: number;
  claim: WatchClaim;
  /**
   * Field name → template, for the fields an automatic move has to fill.
   *
   * The pump never names a field itself: it reads the target route's
   * `requiredFields` from the type's metadata and sends only the intersection
   * with what is configured here (`lib/views/fill.ts`). Empty = nothing to fill,
   * which is what an unconfigured view sends today.
   */
  fill: ViewFill;
}

/** `watch.fill` — one template per field name. */
export type ViewFill = Record<string, string>;

/** A group as declared under the root `groups:`, for ordering and labels. */
export interface ViewGroup {
  title: string;
  /** Whether the panel starts with this group folded. */
  collapsed: boolean;
}

export interface ViewEntry {
  /** Title as written, so a broken view still shows which one it was. */
  title: string;
  /** Why this view cannot be used, in a form the panel can print as-is. */
  error: string | null;
  view: ViewDefinition | null;
}

export interface ViewsConfig {
  path: string;
  /** A missing file is not an error: the panel shows "not configured yet". */
  exists: boolean;
  /** Why the file as a whole could not be used (bad YAML, wrong root shape). */
  error: string | null;
  views: ViewEntry[];
  /** Declared group order and labels; empty when the file declares none. */
  groups: ViewGroup[];
}

/**
 * Where the file may live, in the order it is looked up. The spec names
 * `.pi/views.yaml`; the workspace root is accepted too, for a repository that
 * keeps its tool config at the top level.
 */
export const VIEWS_CONFIG_RELATIVE_PATHS = [
  join(".pi", "views.yaml"),
  join(".pi", "views.yml"),
  "views.yaml",
  "views.yml",
] as const;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** One entry of `views:`; a bad entry never fails the others. */
function parseView(raw: unknown, index: number, projectDir: string): ViewEntry {
  if (!isRecord(raw)) {
    return { title: `#${index + 1}`, error: "这一项不是对象（应为 { title, server, workspace, dql, columns }）", view: null };
  }

  const title = asText(raw.title);
  const problems: string[] = [];

  if (!title) problems.push("缺少 title");
  const server = asText(raw.server);
  if (!server) problems.push("缺少 server（mcp.json 里的名字）");
  const workspace = asText(raw.workspace);
  if (!workspace) problems.push("缺少 workspace");
  const dql = asText(raw.dql);
  if (!dql) problems.push("缺少 dql");

  const rawColumns = raw.columns;
  const columns = Array.isArray(rawColumns)
    ? rawColumns.map(asText).filter((column) => column.length > 0)
    : [];
  if (columns.length === 0) problems.push("columns 必须是非空数组");

  const { orderBy, ok: orderByOk } = parseOrderBy(raw.orderBy, problems);
  const order = parseOrder(raw.order, orderBy, orderByOk, problems);

  let pageSize = DEFAULT_PAGE_SIZE;
  if (raw.pageSize !== undefined && raw.pageSize !== null) {
    const parsed = typeof raw.pageSize === "string" ? Number(raw.pageSize.trim()) : raw.pageSize;
    if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      problems.push(`pageSize 必须是 1–${MAX_PAGE_SIZE} 的整数（写的是 "${String(raw.pageSize)}"）`);
    } else {
      pageSize = parsed;
    }
  }

  // Off means "no reminder", not "no updates": the view still re-evaluates, its
  // new entries just appear without a mark in the list.
  let notify = true;
  if (raw.notify !== undefined && raw.notify !== null) {
    if (typeof raw.notify !== "boolean") {
      problems.push(`notify 只能是 true 或 false（写的是 "${String(raw.notify)}"）`);
    } else {
      notify = raw.notify;
    }
  }

  // A group is a label, so an empty one means "none" rather than an error: a
  // customer who leaves the key in place after ungrouping a view should not get
  // a broken view out of it (SSR-000087 ⑦, SSR-000066 格式校验).
  let group: string | null = null;
  if (raw.group !== undefined && raw.group !== null) {
    const text = asText(raw.group);
    if (typeof raw.group !== "string") {
      problems.push(`group 只能是字符串（写的是 ${JSON.stringify(raw.group)}）`);
    } else if (text.length > 0) {
      group = text;
    }
  }

  if (problems.length > 0) {
    return { title: title || `#${index + 1}`, error: problems.join("；"), view: null };
  }

  const watch = parseWatch(raw.watch, projectDir, problems);
  if (problems.length > 0) {
    return { title: title || `#${index + 1}`, error: problems.join("；"), view: null };
  }

  return {
    title,
    error: null,
    view: { title, server, workspace, dql, columns, orderBy, order, pageSize, notify, group, watch },
  };
}

/**
 * Reads the `watch:` block. Only the shape is checked: a missing key, a wrong
 * type, a number outside its range. Directories, states and routes are checked
 * later, where the entity metadata is available.
 */
function parseWatch(raw: unknown, projectDir: string, problems: string[]): ViewWatch | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    problems.push("watch 必须是对象（含 project / prompt / claim）");
    return null;
  }

  let enabled = true;
  if (raw.enabled !== undefined && raw.enabled !== null) {
    if (typeof raw.enabled !== "boolean") problems.push(`watch.enabled 只能是 true 或 false（写的是 ${JSON.stringify(raw.enabled)}）`);
    else enabled = raw.enabled;
  }

  const projectText = asText(raw.project);
  if (!projectText) problems.push("缺少 watch.project（执行项目目录）");
  const promptText = asText(raw.prompt);
  if (!promptText) problems.push("缺少 watch.prompt（任务说明文件）");

  const intervalSec = positiveInt(raw.intervalSec, 90, "watch.intervalSec", problems);
  const timeoutMin = positiveInt(raw.timeoutMin, 120, "watch.timeoutMin", problems);

  const claimRaw = raw.claim;
  let claim: WatchClaim | null = null;
  if (!isRecord(claimRaw)) {
    problems.push("缺少 watch.claim（from / to / manual）");
  } else {
    const from = asText(claimRaw.from);
    const to = asText(claimRaw.to);
    const manual = asText(claimRaw.manual);
    if (!from) problems.push("缺少 watch.claim.from（待处理状态）");
    if (!to) problems.push("缺少 watch.claim.to（认领状态）");
    if (!manual) problems.push("缺少 watch.claim.manual（待人工状态）");
    if (claimRaw.back !== undefined) {
      problems.push("watch.claim.back 已移除：没有重试，没做完的条目直接进 manual");
    }
    for (const [key, value] of [["from", claimRaw.from], ["to", claimRaw.to], ["manual", claimRaw.manual]] as const) {
      if (value !== undefined && value !== null && typeof value !== "string") {
        problems.push(`watch.claim.${key} 只能是字符串（写的是 ${JSON.stringify(value)}）`);
      }
    }
    if (from && to && manual) claim = { from, to, manual };
  }

  if (raw.maxFailures !== undefined) {
    problems.push("watch.maxFailures 已移除：没有重试，没做完的条目第一次失败就进 manual");
  }

  const fill = parseFill(raw.fill, problems);

  if (problems.length > 0) return null;
  return {
    enabled,
    project: isAbsolute(projectText) ? projectText : join(projectDir, projectText),
    prompt: isAbsolute(promptText) ? promptText : join(projectDir, promptText),
    intervalSec,
    timeoutMin,
    // `claim` cannot be null here: its absence is a problem, and problems returned above.
    claim: claim as WatchClaim,
    fill,
  };
}

/**
 * `watch.fill:` — field name → template string.
 *
 * Only the shape is checked here (a record of non-empty strings over the known
 * placeholders). Whether the configured fields are the ones the route requires
 * needs the type's metadata, so that half is decided by `validate()` — but a
 * typo in a placeholder or an empty template is already knowable now, and
 * leaving either for later would write a literal `{{kye}}` into an entity.
 */
function parseFill(raw: unknown, problems: string[]): ViewFill {
  const fill: ViewFill = {};
  if (raw === undefined || raw === null) return fill;
  if (!isRecord(raw)) {
    problems.push('watch.fill 必须是对象（字段名 → 模板字符串，如 fill: { <字段名>: "【自动】{{reason}}" }）');
    return fill;
  }

  for (const [rawName, rawTemplate] of Object.entries(raw)) {
    const name = rawName.trim();
    if (!name) {
      problems.push("watch.fill 里有空字段名：删掉这一项");
      continue;
    }
    if (typeof rawTemplate !== "string") {
      problems.push(`watch.fill.${name} 只能是模板字符串（写的是 ${JSON.stringify(rawTemplate)}）`);
      continue;
    }
    const template = rawTemplate.trim();
    if (!template) {
      problems.push(`watch.fill.${name} 是空模板：写点内容，或删掉这一项`);
      continue;
    }
    const unknown = unknownPlaceholders(template);
    if (unknown.length > 0) {
      const available = FILL_PLACEHOLDERS.map((placeholder) => `{{${placeholder}}}`).join("、");
      problems.push(
        `watch.fill.${name} 里的 ${unknown.map((placeholder) => `{{${placeholder}}}`).join("、")} 不是可用占位符（可用：${available}）`,
      );
      continue;
    }
    fill[name] = template;
  }
  return fill;
}

/**
 * `orderBy:` — one field name, or an ordered list of them.
 *
 * A list is kept as written, including its order, and an unusable list is a
 * problem rather than a silent repair: dropping one element would make the
 * query sort by something else than the author asked for, which is the same
 * class of defect as an ignored `orderBy` (`SSR-000066` rev20).
 */
function parseOrderBy(
  raw: unknown,
  problems: string[],
): { orderBy: ViewOrderBy | null; ok: boolean } {
  if (raw === undefined || raw === null || raw === "") return { orderBy: null, ok: true };

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      problems.push("orderBy 是空数组：删掉它（不排序）或写上字段名");
      return { orderBy: null, ok: false };
    }
    const keys: string[] = [];
    let ok = true;
    for (const [index, item] of raw.entries()) {
      if (typeof item !== "string") {
        problems.push(`orderBy 第 ${index + 1} 项只能是字段名（写的是 ${JSON.stringify(item)}）`);
        ok = false;
        continue;
      }
      const key = item.trim();
      // An empty element is what a trailing comma or a half-edited list leaves
      // behind. Silently skipping it would change which key is first.
      if (!key) {
        problems.push(`orderBy 第 ${index + 1} 项是空字符串：删掉它或写上字段名`);
        ok = false;
        continue;
      }
      keys.push(key);
    }
    return ok ? { orderBy: keys, ok } : { orderBy: null, ok: false };
  }

  if (typeof raw !== "string") {
    problems.push(`orderBy 只能是字段名或字段名数组（写的是 ${JSON.stringify(raw)}）`);
    return { orderBy: null, ok: false };
  }
  // Single value: unchanged, including "blank means not sorting".
  return { orderBy: asText(raw) || null, ok: true };
}

/** `asc` / `desc`, case-insensitive; null for anything else. */
function asOrder(value: unknown): ViewOrder | null {
  const normalized = asText(value).toLowerCase();
  return normalized === "asc" || normalized === "desc" ? normalized : null;
}

/**
 * An explicit `order` (one value or a list) is a direction for keys, so it only
 * means something next to `orderBy`.
 *
 * Written alone it used to reach the query builder, which sends `order` only
 * when `orderBy` is set — the table then showed an unsorted list while the
 * author believed the sort was configured. `list` already refuses the shape, so
 * the panel refuses it too instead of dropping it silently (product decision A,
 * TASK-000460). One sentence for both shapes: which shape was written is not
 * the mistake.
 */
const ORDER_NEEDS_ORDER_BY = "order 需要同时写 orderBy（只写 order 会被忽略，等于没排序）";

/**
 * `order:` — one direction for all keys, or one per key.
 *
 * A direction list is only meaningful against a key list of the same length;
 * a single value next to a key list keeps its meaning ("all of them",
 * `SSR-000066` rev20). Either shape with no `orderBy` is refused: it describes
 * keys that do not exist, and silently ignoring it is how a user ends up
 * believing the sort is configured.
 */
function parseOrder(
  raw: unknown,
  orderBy: ViewOrderBy | null,
  orderByOk: boolean,
  problems: string[],
): ViewOrderValue {
  if (raw === undefined || raw === null || raw === "") return "desc";

  if (!Array.isArray(raw)) {
    const direction = asOrder(raw);
    if (direction) {
      // A parse failure in `orderBy` already said what to fix; pointing at
      // `order` too would name the wrong field.
      if (orderByOk && orderBy === null) problems.push(ORDER_NEEDS_ORDER_BY);
      return direction;
    }
    problems.push(`order 只能是 asc 或 desc（写的是 "${String(raw)}"）`);
    return "desc";
  }

  if (raw.length === 0) {
    problems.push("order 是空数组：删掉它（方向默认 desc）或写上 asc / desc");
    return "desc";
  }

  const directions: ViewOrder[] = [];
  let ok = true;
  for (const [index, item] of raw.entries()) {
    const direction = asOrder(item);
    if (!direction) {
      problems.push(`order 第 ${index + 1} 项只能是 asc 或 desc（写的是 ${JSON.stringify(item)}）`);
      ok = false;
      continue;
    }
    directions.push(direction);
  }
  if (!ok) return "desc";

  const keyCount = Array.isArray(orderBy) ? orderBy.length : orderBy ? 1 : 0;
  // When `orderBy` itself failed to parse, its length is not a usable fact yet:
  // the error above already says what to fix, and a mismatched-length message on
  // top of it would point at the wrong field.
  if (!orderByOk) return "desc";
  if (keyCount === 0) {
    // Same sentence as the single-value case above: the mistake is "no
    // `orderBy`", not "a list instead of a value".
    problems.push(ORDER_NEEDS_ORDER_BY);
    return "desc";
  }
  if (directions.length !== keyCount) {
    problems.push(
      `order 有 ${directions.length} 个方向，orderBy 有 ${keyCount} 个键（长度不齐；只写一个方向即作用于全部键）`,
    );
    return "desc";
  }
  return directions;
}

function positiveInt(raw: unknown, fallback: number, field: string, problems: string[]): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    problems.push(`${field} 必须是正整数（写的是 ${JSON.stringify(raw)}）`);
    return fallback;
  }
  return parsed;
}

/** Reads and validates the file at `cwd`. Never throws: problems come back as text. */
export function readViewsConfig(cwd: string): ViewsConfig {
  const candidates = VIEWS_CONFIG_RELATIVE_PATHS.map((relative) => ({
    relative,
    absolute: join(cwd, relative),
  }));
  const found = candidates.find((candidate) => existsSync(candidate.absolute));
  if (!found) {
    return { path: candidates[0].absolute, exists: false, error: null, views: [], groups: [] };
  }

  let text: string;
  try {
    text = readFileSync(found.absolute, "utf8");
  } catch (error) {
    return {
      path: found.absolute,
      exists: true,
      error: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      views: [],
      groups: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = loadYaml(text);
  } catch (error) {
    return {
      path: found.absolute,
      exists: true,
      error: `YAML 解析失败：${error instanceof Error ? error.message : String(error)}`,
      views: [],
      groups: [],
    };
  }

  if (!isRecord(parsed)) {
    return {
      path: found.absolute,
      exists: true,
      error: "根节点必须是对象，形如 views: [...]",
      views: [],
      groups: [],
    };
  }

  const rawViews = parsed.views;
  if (!Array.isArray(rawViews)) {
    return {
      path: found.absolute,
      exists: true,
      error: "缺少 views 数组（views: [...]）",
      views: [],
      groups: [],
    };
  }

  const views = rawViews.map((raw, index) => parseView(raw, index, cwd));

  // Duplicated titles would make two tabs indistinguishable in the panel.
  const seen = new Set<string>();
  for (const entry of views) {
    if (entry.error || !entry.view) continue;
    const key = entry.title.toLowerCase();
    if (seen.has(key)) {
      entry.error = `title 重复："${entry.title}"`;
      entry.view = null;
    } else {
      seen.add(key);
    }
  }

  const groups = parseGroups(parsed.groups);
  if (typeof groups === "string") {
    return { path: found.absolute, exists: true, error: groups, views: [], groups: [] };
  }

  return { path: found.absolute, exists: true, error: null, views, groups };
}

/**
 * `groups:` only orders and labels the navigation; it never adds or hides a
 * view. A malformed list is a file-level problem because there is no view to
 * attach it to (SSR-000066 ①: the panel shows the reason rather than guessing).
 */
function parseGroups(raw: unknown): ViewGroup[] | string {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "groups 必须是数组（可写组名或 { title, collapsed }）";

  const groups: ViewGroup[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item === "string") {
      const title = item.trim();
      if (!title) return `groups 第 ${index + 1} 项是空字符串，删掉它或写上组名`;
      groups.push({ title, collapsed: false });
      continue;
    }
    if (!isRecord(item)) {
      return `groups 第 ${index + 1} 项既不是组名也不是 { title, collapsed }`;
    }
    const title = asText(item.title);
    if (!title) return `groups 第 ${index + 1} 项缺少 title`;
    let collapsed = false;
    if (item.collapsed !== undefined && item.collapsed !== null) {
      if (typeof item.collapsed !== "boolean") {
        return `groups 第 ${index + 1} 项的 collapsed 只能是 true 或 false`;
      }
      collapsed = item.collapsed;
    }
    groups.push({ title, collapsed });
  }
  return groups;
}
