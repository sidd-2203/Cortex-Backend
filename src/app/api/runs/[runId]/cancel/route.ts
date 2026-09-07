import { NextRequest, NextResponse } from "next/server";
import { wait } from "@trigger.dev/sdk";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId, logger } from "@/lib/logger";
import { CancelRunResponseSchema } from "@/contracts/chat";
import type { Prisma } from "../../../../../../prisma/generated/prisma/client";

type Params = { params: Promise<{ runId: string }> };

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

const TERMINAL = ["COMPLETE", "FAILED", "CANCELLED"] as const;

/**
 * Asks a running turn to stop. Cooperative by design: this only flips the
 * run to STOPPING, and run-turn.ts notices between steps and winds down —
 * an in-flight tool call is allowed to finish rather than being killed
 * mid-request, which is what keeps a paid Magica job from being orphaned
 * after we'd already been charged for it.
 *
 * A run parked on an approval waitpoint would never reach one of those
 * checkpoints on its own, so any PENDING waitpoint is also completed here
 * as a denial — that's what makes Stop responsive while the run is blocked
 * asking a question, instead of hanging until the approval times out.
 *
 * Idempotent: cancelling an already-terminal (or already-stopping) run
 * returns its current status rather than erroring, so a double-click on
 * Stop is harmless.
 */
export async function POST(_req: NextRequest, { params }: Params) {
  const { runId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();

    const run = await prisma.agentRun.findUnique({
      where: { id: runId },
      include: { chat: { select: { ownerId: true } } },
    });
    // Same 404-not-403 rule as everywhere else: an authenticated caller
    // can't distinguish someone else's run from one that doesn't exist.
    if (!run || run.chat.ownerId !== user.id) {
      throw new NotFoundError("Run");
    }

    if ((TERMINAL as readonly string[]).includes(run.status)) {
      return NextResponse.json(CancelRunResponseSchema.parse({ status: run.status }));
    }

    await prisma.agentRun.updateMany({
      where: { id: runId, status: { notIn: [...TERMINAL] } },
      data: { status: "STOPPING" },
    });

    // Release anything the run is currently blocked on. completeToken is
    // what actually un-parks the task; the row update is our own record of
    // why, and is conditional so it can't stomp a decision that landed
    // first.
    const pending = await prisma.waitpoint.findMany({
      where: { runId, status: "PENDING" },
      select: { token: true },
    });
    for (const { token } of pending) {
      try {
        await wait.completeToken(token, { approved: false, comment: "Run stopped by the user" });
        await prisma.waitpoint.updateMany({
          where: { token, status: "PENDING" },
          data: {
            status: "RESOLVED",
            resolution: asJson({ approved: false, comment: "Run stopped by the user" }),
            resolvedAt: new Date(),
          },
        });
      } catch (err) {
        // A token that's already been completed (the user answered it in
        // the same moment they hit Stop) throws here — the run is still
        // marked STOPPING and will wind down at its next checkpoint, so
        // this is logged rather than failing the whole request.
        logger.warn("failed to release waitpoint on cancel", {
          runId,
          traceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return NextResponse.json(CancelRunResponseSchema.parse({ status: "STOPPING" }));
  });
}
