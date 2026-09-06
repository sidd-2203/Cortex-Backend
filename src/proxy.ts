import { NextResponse } from "next/server";
import { clerkMiddleware } from "@clerk/nextjs/server";

// Next.js 16 renamed the `middleware.ts` convention to `proxy.ts` (the
// exported function is `proxy`, not `middleware`) and dropped the Edge
// runtime for it — it now always runs on Node.js. clerkMiddleware()'s
// handler signature is runtime-agnostic, so it works unchanged under the
// new name; only the file/export name changed.
//
// This used to also gate access with createRouteMatcher()-based path
// matching, but Clerk now recommends against that: path-based middleware
// auth can diverge from how Next.js actually routes a request (e.g. Server
// Functions callable by id) and creates a false sense of security. Every
// route here already enforces its own auth via requireUser() (see
// src/lib/auth.ts), which is the resource itself deciding, not a path
// pattern — so this file is CORS handling only now.
// Comma-separated so a deployed FRONTEND_ORIGIN doesn't fight with local
// dev — localhost:3001 is always allowed regardless of what's configured,
// since needing to swap this value back and forth to test locally is its
// own bug.
const allowedOrigins = [
  ...(process.env.FRONTEND_ORIGIN?.split(",").map((o) => o.trim()) ?? []),
  "http://localhost:3001",
];

// Every non-production frontend deployment (a unique URL per push, plus a
// stable per-branch alias) gets a fresh vercel.app subdomain that FRONTEND_ORIGIN
// can't be kept in sync with — there's a new one every deploy. Vercel's own
// team slug in the hostname is what makes this safe to pattern-match rather
// than exact-match: only deployments under this account can ever get a
// cortex-frontend-*-cortex-2a0b.vercel.app hostname, so this can't be
// spoofed by an unrelated vercel.app project.
const PREVIEW_ORIGIN_PATTERN = /^https:\/\/cortex-frontend(-[a-z0-9-]+)?-cortex-2a0b\.vercel\.app$/;

function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.includes(origin) || PREVIEW_ORIGIN_PATTERN.test(origin);
}

function withCors(res: NextResponse, origin: string | null) {
  if (origin && isAllowedOrigin(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
    res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return res;
}

export const proxy = clerkMiddleware(async (_auth, req) => {
  const origin = req.headers.get("origin");

  // A CORS preflight carries no Authorization header/cookie, so it must be
  // answered before anything auth-related runs.
  if (req.method === "OPTIONS" && req.nextUrl.pathname.startsWith("/api/")) {
    const res = new NextResponse(null, { status: 204 });
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.headers.set("Access-Control-Max-Age", "86400");
    return withCors(res, origin);
  }

  return withCors(NextResponse.next(), origin);
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
