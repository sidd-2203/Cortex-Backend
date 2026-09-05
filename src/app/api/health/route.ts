import { NextResponse } from "next/server";

// Public — used by Vercel/uptime checks and as the one route the Clerk proxy
// deliberately leaves unauthenticated (see src/proxy.ts).
export async function GET() {
  return NextResponse.json({ status: "ok", time: new Date().toISOString() });
}
