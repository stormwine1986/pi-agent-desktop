import { isAbsolute, resolve } from "node:path";
import { NextResponse } from "next/server";
import { getSubscriptionsStatus } from "@/lib/subscriptions/runner";

export const dynamic = "force-dynamic";

/**
 * What the sidebar polls to decide whether the Subscriptions row needs a dot.
 * Deliberately does no file IO beyond the app's own state file, so polling it
 * every few seconds is cheap — and it never starts a collector.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("cwd");
  if (!raw) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  if (!isAbsolute(raw)) return NextResponse.json({ error: "cwd must be absolute" }, { status: 400 });
  return NextResponse.json(getSubscriptionsStatus(resolve(raw)));
}
