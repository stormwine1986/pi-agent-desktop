import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { callMcpTool, resolveMcpTarget } from "@/lib/mcp-call";
import { readViewsConfig, type ViewDefinition } from "@/lib/views/config";
import { validate, watchViewStatus } from "@/lib/views/watch";
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
  watch: { disabled: string | null; inFlight: boolean } | null;
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
 * only for views this process has not seen.
 */
async function watchStatusOf(cwd: string, view: ViewDefinition): Promise<{ disabled: string | null; inFlight: boolean } | null> {
  if (!view.watch) return null;
  const known = watchViewStatus(cwd, view);
  if (known) return known;
  return { disabled: await validate(cwd, view, view.watch, createLiveDeps()), inFlight: false };
}

async function runView(agentDir: string, cwd: string, view: ViewDefinition, offset: number): Promise<ViewRows> {
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
    watch: await watchStatusOf(cwd, view),
    error: null,
  };
  // The error has to name the query that failed: the panel shows it as-is, and
  // "which DQL is this?" is the first question a broken view raises.
  const withQuery = (reason: string) => `${reason}\nDQL：${view.dql}`;
  const target = resolveMcpTarget(agentDir, cwd, view.server);
  if (!target.ok) return { ...empty, error: withQuery(target.error) };

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
    watch: await watchStatusOf(cwd, view),
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
