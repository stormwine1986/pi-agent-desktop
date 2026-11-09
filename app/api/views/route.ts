import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { callMcpTool, resolveMcpTarget, type McpHttpTarget } from "@/lib/mcp-call";
import { readViewsConfig, type ViewDefinition } from "@/lib/views/config";
import { checkOrderBy, declaredSortFields } from "@/lib/views/order-by";
import { validate, watchViewStatus } from "@/lib/views/watch";
import { dispatchGate } from "@/lib/views/watch/pump";
import { describeGate } from "@/lib/views/watch/core";
import { createLiveDeps } from "@/lib/views/watch/runtime";

export const dynamic = "force-dynamic";

/**
 * Rows for the to-do views declared by `.pi/views.yaml`.
 *
 * Each view is answered on its own: one broken DQL or one unreachable server
 * must not blank the panel, and the panel needs the reason per view — an empty
 * table would read as "nothing to do", which is exactly the failure this
 * feature cannot afford.
 */
/** The identity of one row's entity, so the panel can hand the row to a conversation. */
interface RowEntity {
  key: string;
  name: string;
  state: string;
}

interface ViewRows {
  title: string;
  /** Data channel and space the view reads from, needed to hand a row to a conversation. */
  server: string;
  workspace: string;
  columns: string[];
  rows: string[][];
  /** Aligned with `rows`: the entity behind each row, independent of which columns were configured. */
  entities: RowEntity[];
  /** Whether the panel may announce new rows for this view. */
  notify: boolean;
  /** Navigation group this view belongs to; null when ungrouped. */
  group: string | null;
  /** Where this page starts, and how many rows match in total (null = the base did not say). */
  offset: number;
  total: number | null;
  /** The view's page size, so the panel can move by a page rather than by a guess. */
  pageSize: number;
  /** Dispatch state for a watched view: why it is not dispatching, and whether it is running. */
  watch: { disabled: string | null; inFlight: boolean; skipped: string | null } | null;
  error: string | null;
}

/** `created_by` → `createdBy` and back, so a column name works whichever the server uses. */
function aliases(column: string): string[] {
  const camel = column.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
  const snake = column.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return [column, camel, snake].filter((name, index, all) => all.indexOf(name) === index);
}

function cell(item: unknown, column: string): string {
  if (typeof item !== "object" || item === null) return "";
  const record = item as Record<string, unknown>;
  const fields = typeof record.fields === "object" && record.fields !== null
    ? (record.fields as Record<string, unknown>)
    : undefined;

  let value: unknown;
  for (const name of aliases(column)) {
    if (record[name] !== undefined) {
      value = record[name];
      break;
    }
    if (fields?.[name] !== undefined) {
      value = fields[name];
      break;
    }
  }

  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/**
 * Why a watched view is not dispatching.
 *
 * The pump keeps that reason in memory, but only the process holding the lease
 * scans views — so a second window (dev server beside the app) would show an
 * empty answer. Validating here covers that case; it is one metadata read, and
 * only for views this process has not seen. The gate probe below is the same
 * one round the pump would take: the app's running sessions for ④, and the
 * `manual` slice for ⑦.
 */
async function watchStatusOf(
  cwd: string,
  view: ViewDefinition,
): Promise<{ disabled: string | null; inFlight: boolean; skipped: string | null } | null> {
  if (!view.watch) return null;
  const known = watchViewStatus(cwd, view);
  if (known) return known;
  // `enabled: false` is the pause switch, not a failure: no gate reason to show.
  if (!view.watch.enabled) return { disabled: null, inFlight: false, skipped: null };

  const deps = createLiveDeps();
  const disabled = await validate(cwd, view, view.watch, deps);
  if (disabled) return { disabled, inFlight: false, skipped: null };

  const gate = await dispatchGate(
    { view, watch: view.watch, target: { panelCwd: cwd, server: view.server, workspace: view.workspace } },
    deps,
  );
  // A failed probe is not a reason to claim the view is fine: leave the skip
  // line empty and let the list query's own error speak.
  return { disabled: null, inFlight: false, skipped: gate.ok && gate.value ? describeGate(gate.value) : null };
}

/**
 * A sort key that does not exist is caught before the query, so a typo is not
 * discovered by paying for a failed round trip (`SSR-000066` AC-2).
 *
 * The type's field list is cached per endpoint + space + type: the panel asks
 * every 60 seconds per view, and a dozen views over one type must not become a
 * dozen metadata reads. A failure is remembered for a shorter while, so a
 * server that is briefly down does not cost a request per view per refresh —
 * and an unknown list (null) abstains, leaving the verdict to `list`.
 */
const SORT_FIELD_TTL_MS = 5 * 60_000;
const SORT_FIELD_FAILURE_TTL_MS = 30_000;

interface SortFieldCacheEntry {
  fields: string[] | null;
  expiresAt: number;
}

const sortFieldCache = new Map<string, SortFieldCacheEntry>();

/** The type a view reads, from its DQL; `null` when it names none. */
function typeOf(dql: string): string | null {
  const match = /\btype\s*=\s*(['"])([^'"]+)\1/i.exec(dql);
  return match ? match[2] : null;
}

async function sortFieldsFor(
  target: McpHttpTarget,
  workspace: string,
  type: string,
): Promise<string[] | null> {
  const key = `${target.url}\u0000${workspace}\u0000${type}`;
  const now = Date.now();
  const cached = sortFieldCache.get(key);
  if (cached && cached.expiresAt > now) return cached.fields;

  const metadata = await callMcpTool(target, "get_metadata", { type });
  const fields = metadata.ok ? declaredSortFields(metadata.value) : null;
  sortFieldCache.set(key, {
    fields,
    expiresAt: now + (fields ? SORT_FIELD_TTL_MS : SORT_FIELD_FAILURE_TTL_MS),
  });
  return fields;
}

/** Names the reason `orderBy` cannot be used, or null when it is fine. */
async function orderByProblem(target: McpHttpTarget, view: ViewDefinition): Promise<string | null> {
  if (!view.orderBy) return null;
  const type = typeOf(view.dql);
  // No type in the DQL: the field list belongs to no type, so say nothing and
  // let `list` judge (failing open is the rule here).
  if (!type) return null;
  const declared = await sortFieldsFor(target, view.workspace, type);
  const verdict = checkOrderBy(view.orderBy, declared);
  return verdict.ok ? null : verdict.error;
}

async function runView(agentDir: string, cwd: string, view: ViewDefinition, offset: number): Promise<ViewRows> {
  // Asked once: the fallback path may validate and probe a gate, and doing that
  // twice per refresh would double every query this view costs.
  const watch = await watchStatusOf(cwd, view);
  const empty = {
    title: view.title,
    server: view.server,
    workspace: view.workspace,
    columns: view.columns,
    rows: [],
    entities: [],
    notify: view.notify,
    group: view.group,
    offset,
    total: null,
    pageSize: view.pageSize,
    watch,
    error: null,
  };
  // The error has to name the query that failed: the panel shows it as-is, and
  // "which DQL is this?" is the first question a broken view raises.
  const withQuery = (reason: string) => `${reason}\nDQL：${view.dql}`;
  const target = resolveMcpTarget(agentDir, cwd, view.server);
  if (!target.ok) return { ...empty, error: withQuery(target.error) };

  const orderByReason = await orderByProblem(target.target, view);
  if (orderByReason) return { ...empty, error: withQuery(orderByReason) };

  const args: Record<string, unknown> = {
    workspaceId: view.workspace,
    query: view.dql,
    limit: view.pageSize,
    offset,
    // Asked for every page, not just when someone wants a count: "1–50 of 320"
    // is how a user finds out the view has more rows than one screen.
    includeTotal: true,
  };
  if (view.orderBy) {
    args.orderBy = view.orderBy;
    args.order = view.order;
  }

  const result = await callMcpTool(target.target, "list", args);
  if (!result.ok) return { ...empty, error: withQuery(result.error) };

  const payload = result.value as { items?: unknown; total?: unknown };
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!Array.isArray(payload?.items)) {
    return { ...empty, error: withQuery("list 的返回里没有 items 数组") };
  }

  return {
    title: view.title,
    server: view.server,
    workspace: view.workspace,
    columns: view.columns,
    rows: items.map((item) => view.columns.map((column) => cell(item, column))),
    entities: items.map((item) => {
      const record = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      return {
        key: record.key === undefined || record.key === null ? "" : String(record.key),
        name: record.name === undefined || record.name === null ? "" : String(record.name),
        state: record.state === undefined || record.state === null ? "" : String(record.state),
      };
    }),
    notify: view.notify,
    group: view.group,
    offset,
    total: typeof payload?.total === "number" ? payload.total : null,
    pageSize: view.pageSize,
    watch,
    error: null,
  };
}

/**
 * `offsets={"0":50,"2":100}` — a per-view start position.
 *
 * Indexed by position in the file, like the panel's selection. Anything that is
 * not a finite number is dropped rather than rejected: a stale URL should show
 * the first page, not an error page.
 */
function parseOffsets(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const offsets: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) offsets[key] = Math.floor(value);
    }
    return offsets;
  } catch {
    return {};
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawCwd = url.searchParams.get("cwd");
  if (!rawCwd) return NextResponse.json({ error: "cwd is required" }, { status: 400 });

  const cwd = resolve(rawCwd);
  let stats;
  try {
    stats = await stat(cwd);
  } catch {
    return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!stats.isDirectory()) return NextResponse.json({ error: `Not a directory: ${cwd}` }, { status: 400 });

  // The yaml decides which hosts get contacted and which workspace is read, so
  // it is read under the same allow-list as any other workspace file.
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const config = readViewsConfig(cwd);
  if (!config.exists) {
    return NextResponse.json({ path: config.path, exists: false, error: null, views: [] });
  }
  if (config.error) {
    return NextResponse.json({ path: config.path, exists: true, error: config.error, views: [], groups: [] });
  }

  // `?probe=1` answers "does this project have views?" without running a single
  // query. The panel asks this when it opens to decide between the to-do list
  // and the file tree; evaluating every view there would cost a round trip to
  // each MCP server before anything is shown.
  if (url.searchParams.get("probe") === "1") {
    return NextResponse.json({ path: config.path, exists: true, error: null, views: [], groups: config.groups });
  }

  const agentDir = getAgentDir();
  // Per-view offsets: each view pages on its own (SR-000023 ③), so one panel
  // showing A on page 3 must not move B. Keyed by index because that is what
  // the panel selects by; a missing or malformed entry means "first page".
  const offsets = parseOffsets(url.searchParams.get("offsets"));
  const views = await Promise.all(
    config.views.map(async (entry, index): Promise<ViewRows> => {
      // A view that failed validation still occupies its slot in the panel: the
      // user needs to see which entry is broken.
      if (!entry.view) {
        return { title: entry.title, server: "", workspace: "", columns: [], rows: [], entities: [], notify: true, group: null, offset: 0, total: null, pageSize: 0, watch: null, error: entry.error ?? "配置无效" };
      }
      return runView(agentDir, cwd, entry.view, offsets[index] ?? 0);
    }),
  );

  return NextResponse.json({ path: config.path, exists: true, error: null, views, groups: config.groups });
}
