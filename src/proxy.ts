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
const allowedOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3001";

function withCors(res: NextResponse, origin: string | null) {
  if (origin && origin === allowedOrigin) {
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
