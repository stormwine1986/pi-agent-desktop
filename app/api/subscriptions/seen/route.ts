import { isAbsolute, resolve } from "node:path";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { markWorkspaceSeen } from "@/lib/subscriptions/store";

export const dynamic = "force-dynamic";

/** The Subscriptions page calls this once it has shown the workspace's events. */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { cwd?: unknown };
  try {
    body = await req.json() as { cwd?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.cwd !== "string" || !isAbsolute(body.cwd)) {
    return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
  }

  try {
    markWorkspaceSeen(resolve(body.cwd));
    return NextResponse.json({ unread: 0 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
