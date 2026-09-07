import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth-api-key";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { serializeMessage } from "@/lib/serialize";
import { RunStatusResponseSchema } from "@/contracts/public-api";

type Params = { params: Promise<{ runId: string }> };

/**
 * Poll target for both async entry points (message submission, chat
 * completions, direct tool execution) — a caller that isn't using webhooks
 * gets the run's current state here, including any tool calls it made and
 * the assistant's message once it exists. A direct tool-execution run has
 * no message at all (see run-direct-tool.ts) — `message` is null and
 * `tools` is what actually carries the result.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { runId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, runId }, async () => {
    const { ownerId } = await requireApiKey(_req);

    const run = await prisma.agentRun.findFirst({
      where: { id: runId, chat: { ownerId } },
      include: {
        tools: { orderBy: { sequence: "asc" } },
        messages: { where: { role: "ASSISTANT" }, orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!run) throw new NotFoundError("Run");

    const body = RunStatusResponseSchema.parse({
      id: run.id,
      chatId: run.chatId,
      status: run.status,
      model: run.model,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      endedAt: run.endedAt?.toISOString() ?? null,
      message: run.messages[0] ? serializeMessage(run.messages[0]) : null,
      tools: run.tools.map((t) => ({
        id: t.id,
        toolName: t.toolName,
        input: t.input,
        output: t.output,
        status: t.status,
        cost: t.cost,
        durationMs: t.durationMs,
      })),
    });
    return NextResponse.json(body);
  });
}
