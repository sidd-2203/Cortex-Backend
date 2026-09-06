import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "./db";
import { SIGNUP_GRANT_CREDITS } from "./credits/ledger";

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

  // User creation and its starting-balance ledger entry land together —
  // the ledger is the source of truth for how a balance got to where it
  // is, so a balance should never exist without a row explaining it.
  // create() (not upsert) so a concurrent duplicate call fails outright
  // instead of silently granting credits twice — the loser just re-fetches
  // what the winner created.
  try {
    const [user] = await prisma.$transaction([
      prisma.user.create({ data: { id: userId, email, creditBalance: SIGNUP_GRANT_CREDITS } }),
      prisma.creditLedger.create({ data: { ownerId: userId, delta: SIGNUP_GRANT_CREDITS, reason: "GRANT" } }),
    ]);
    return user;
  } catch {
    return prisma.user.findUniqueOrThrow({ where: { id: userId } });
  }
}
