import { prisma } from "@/lib/db";

export class InsufficientCreditsError extends Error {
  constructor(
    public required: number,
    public available: number,
  ) {
    super(`Insufficient credits: this costs ${required}, balance is ${available}`);
    this.name = "InsufficientCreditsError";
  }
}

export async function getBalance(ownerId: string): Promise<number> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
  return user.creditBalance;
}

/**
 * Cheap pre-flight check before starting expensive work (e.g. before ever
 * calling a paid external API) — not itself the enforcement point, just
 * avoids doing real work for a request that's going to fail to settle
 * anyway. `settleToolCharge` is what's actually atomic against a race.
 */
export async function requireSufficientCredits(ownerId: string, cost: number): Promise<void> {
  if (cost <= 0) return;
  const balance = await getBalance(ownerId);
  if (balance < cost) {
    throw new InsufficientCreditsError(cost, balance);
  }
}

/**
 * Settles a billable tool invocation exactly once. Idempotent on
 * `toolInvocationId` — calling this twice for the same invocation (a retry,
 * a duplicate settlement attempt) is a no-op the second time, not a double
 * charge. The balance check + decrement is one atomic conditional UPDATE
 * (`creditBalance >= cost`), not a separate read-then-write, so two
 * concurrent tool calls racing for the last of a balance can't both
 * succeed — checking that this call is unbilled first (the ledger
 * relatedInvocationId is unique) short-circuits before that dance.
 */
export async function settleToolCharge(params: {
  ownerId: string;
  toolInvocationId: string;
  cost: number;
}): Promise<void> {
  if (params.cost <= 0) return;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.creditLedger.findUnique({
      where: { relatedInvocationId: params.toolInvocationId },
    });
    if (existing) return; // already settled

    const { count } = await tx.user.updateMany({
      where: { id: params.ownerId, creditBalance: { gte: params.cost } },
      data: { creditBalance: { decrement: params.cost } },
    });
    if (count === 0) {
      const user = await tx.user.findUniqueOrThrow({ where: { id: params.ownerId } });
      throw new InsufficientCreditsError(params.cost, user.creditBalance);
    }

    await tx.creditLedger.create({
      data: {
        ownerId: params.ownerId,
        delta: -params.cost,
        reason: "TOOL_CHARGE",
        relatedInvocationId: params.toolInvocationId,
      },
    });
  });
}

/** Starting balance for a brand-new user — see requireUser() in src/lib/auth.ts. */
export const SIGNUP_GRANT_CREDITS = 100;

export async function grantSignupCredits(ownerId: string): Promise<void> {
  await prisma.$transaction([
    prisma.user.update({ where: { id: ownerId }, data: { creditBalance: { increment: SIGNUP_GRANT_CREDITS } } }),
    prisma.creditLedger.create({
      data: { ownerId, delta: SIGNUP_GRANT_CREDITS, reason: "GRANT" },
    }),
  ]);
}
