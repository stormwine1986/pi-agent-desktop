import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { rememberSubscriptionsWorkspace } from "@/lib/subscriptions/boot";
import { getSubscriptionsSnapshot } from "@/lib/subscriptions/runner";

export const dynamic = "force-dynamic";

/**
 * Snapshot for the Subscriptions page: the sources declared by the workspace's
 * `subscriptions.yaml` (with their live connection state) plus the newest
 * recorded events. Reading it also starts collection for that workspace, so
 * opening the tab is the only thing the user has to do.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("cwd");
  if (!raw) return NextResponse.json({ error: "cwd is required" }, { status: 400 });

  const cwd = resolve(raw);
  let stats;
  try {
    stats = await stat(cwd);
  } catch {
    return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!stats.isDirectory()) return NextResponse.json({ error: `Not a directory: ${cwd}` }, { status: 400 });

  // The yaml decides which hosts get contacted, so it is read under the same
  // allow-list as any other workspace file.
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const requested = Number(url.searchParams.get("limit") ?? "200");
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 1_000) : 200;
  try {
    // Remembered so the next server start resumes collection without a page.
    rememberSubscriptionsWorkspace(cwd);
    return NextResponse.json(getSubscriptionsSnapshot(cwd, limit));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
