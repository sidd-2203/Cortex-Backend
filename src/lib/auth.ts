import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "./db";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * Resolves the authenticated Clerk user and ensures a matching `User` row
 * exists in Postgres (created lazily on first request rather than via a
 * webhook, to keep Day-1 setup to a single moving part). Every mutation in
 * the app should go through this rather than trusting a client-supplied id.
 */
export async function requireUser() {
  const { userId } = await auth();
  if (!userId) throw new UnauthorizedError();

  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (existing) return existing;

  const clerkUser = await currentUser();
  const email = clerkUser?.primaryEmailAddress?.emailAddress ?? `${userId}@unknown.local`;

  return prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, email },
  });
}
