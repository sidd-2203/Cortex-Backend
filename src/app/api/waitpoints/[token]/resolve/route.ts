import { NextRequest, NextResponse } from "next/server";
import { wait } from "@trigger.dev/sdk";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { ResolveWaitpointRequestSchema, ResolveWaitpointResponseSchema } from "@/contracts/waitpoints";
import type { Prisma } from "../../../../../../prisma/generated/prisma/client";

type Params = { params: Promise<{ token: string }> };

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * A human answering an approval waitpoint. Ownership is checked through the
 * waitpoint -> run -> chat chain, same 404-not-403 rule as everywhere else
 * (an authenticated caller can't distinguish someone else's waitpoint from
 * one that doesn't exist).
 *
 * Idempotent by design — a duplicate submission (double-click, retry) for
 * an already-resolved waitpoint just returns its current state instead of
 * erroring, and the DB write is a conditional PENDING -> terminal update
 * that only ever applies once regardless of how many times this fires.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();

    const waitpoint = await prisma.waitpoint.findUnique({
      where: { token },
      include: { run: { include: { chat: { select: { ownerId: true } } } } },
    });
    if (!waitpoint || waitpoint.run.chat.ownerId !== user.id) {
      throw new NotFoundError("Waitpoint");
    }

    if (waitpoint.status !== "PENDING") {
      // Already resolved or expired — tolerate the duplicate submission.
      return NextResponse.json(ResolveWaitpointResponseSchema.parse({ status: waitpoint.status }));
    }

    const input = ResolveWaitpointRequestSchema.parse(await req.json());

    await wait.completeToken(token, { approved: input.approved, comment: input.comment });

    // Best-effort immediate reflection in our own row — the task-side
    // continuation (requestApproval, after its own wait.forToken resolves)
    // writes the same terminal state independently, whichever gets there
    // first wins since both are conditional on status still being PENDING.
    await prisma.waitpoint.updateMany({
      where: { token, status: "PENDING" },
      data: {
        status: "RESOLVED",
        resolution: asJson({ approved: input.approved, comment: input.comment }),
        resolvedAt: new Date(),
      },
    });

    return NextResponse.json(ResolveWaitpointResponseSchema.parse({ status: "RESOLVED" }));
  });
}
