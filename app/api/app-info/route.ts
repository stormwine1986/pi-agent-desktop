import { NextResponse } from "next/server";
import { readAppInfo } from "@/lib/app-build-info-server";

// The Settings "Version" row reads exactly this endpoint: one answer for the
// interface and for anything else that asks a running build what it is
// (SSR-000096 ④). `no-store` because an overwrite install replaces the manifest
// under a running app — a cached response would describe the previous build.
export const dynamic = "force-dynamic";

export async function GET() {
  const info = await readAppInfo();
  return NextResponse.json(info, {
    headers: { "Cache-Control": "no-store" },
  });
}
