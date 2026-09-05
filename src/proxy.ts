import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Next.js 16 renamed the `middleware.ts` convention to `proxy.ts` (the
// exported function is `proxy`, not `middleware`) and dropped the Edge
// runtime for it — it now always runs on Node.js. clerkMiddleware()'s
// handler signature (request, event) is runtime-agnostic, so it works
// unchanged under the new name; only the file/export name changed.
const isPublicRoute = createRouteMatcher(["/api/health"]);
const isApiRoute = createRouteMatcher(["/api/(.*)"]);

export const proxy = clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;

  const { userId } = await auth();
  if (userId) return;

  // auth.protect() alone decides redirect-vs-401 from the Sec-Fetch-Dest
  // header, which a plain fetch() call may not send in every environment.
  // For a REST API that's not a safe default: every /api/* route must
  // return a clean 401 JSON body, never an HTML redirect a JSON client
  // would have to special-case.
  if (isApiRoute(req)) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
  }
  await auth.protect();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
