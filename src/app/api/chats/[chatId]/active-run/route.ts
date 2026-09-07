import { NextRequest, NextResponse } from "next/server";
import { auth as triggerAuth } from "@trigger.dev/sdk";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { ActiveRunResponseSchema } from "@/contracts/chat";

type Params = { params: Promise<{ chatId: string }> };

const NON_TERMINAL_RUN_STATUSES = ["QUEUED", "THINKING", "WORKING", "WAITING", "STOPPING"] as const;

/**
 * Reload recovery: on mount (or when switching to a chat), the frontend
 * calls this to ask "is there an in-flight run here?" — if so, it gets a
 * fresh Realtime subscription and resumes watching it instead of the
 * response silently vanishing because the browser tab reloaded mid-stream.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const user = await requireUser();
    const chat = await prisma.chat.findFirst({ where: { id: chatId, ownerId: user.id, deletedAt: null } });
    if (!chat) throw new NotFoundError("Chat");

    const activeRun = await prisma.agentRun.findFirst({
      where: { chatId, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
    });

    if (!activeRun || !activeRun.triggerRunId) {
      return NextResponse.json(ActiveRunResponseSchema.parse(null));
    }

    const publicAccessToken = await triggerAuth.createPublicToken({
      scopes: { read: { runs: [activeRun.triggerRunId] } },
    });

    const body = ActiveRunResponseSchema.parse({
      runId: activeRun.id,
      triggerRunId: activeRun.triggerRunId,
      publicAccessToken,
      status: activeRun.status,
    });
    return NextResponse.json(body);
  });
}
