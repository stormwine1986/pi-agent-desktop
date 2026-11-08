import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
// js-yaml 5 ships named exports only (no default), so import the function.
import { load as loadYaml } from "js-yaml";

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
 *
 * Nothing here is prescriptive about which fields exist: `columns` is whatever
 * the workspace defines, and a column with no value renders empty rather than
 * failing the view.
 */
export type ViewOrder = "asc" | "desc";

export interface ViewDefinition {
  title: string;
  /** MCP server name from `mcp.json`. */
  server: string;
  /** Workspace id passed to `list` (the tool rejects calls without one). */
  workspace: string;
  dql: string;
  columns: string[];
  orderBy: string | null;
  order: ViewOrder;
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
}

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

  const orderBy = asText(raw.orderBy) || null;

  let order: ViewOrder = "desc";
  const rawOrder = raw.order;
  if (rawOrder !== undefined && rawOrder !== null && rawOrder !== "") {
    const normalized = asText(rawOrder).toLowerCase();
    if (normalized === "asc" || normalized === "desc") order = normalized;
    else problems.push(`order 只能是 asc 或 desc（写的是 "${String(rawOrder)}"）`);
  }

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

  if (problems.length > 0) return null;
  return {
    enabled,
    project: isAbsolute(projectText) ? projectText : join(projectDir, projectText),
    prompt: isAbsolute(promptText) ? promptText : join(projectDir, promptText),
    intervalSec,
    timeoutMin,
    // `claim` cannot be null here: its absence is a problem, and problems returned above.
    claim: claim as WatchClaim,
  };
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
