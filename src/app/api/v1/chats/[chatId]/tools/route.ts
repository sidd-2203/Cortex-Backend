import { NextRequest, NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk";
import { requireApiKey } from "@/lib/auth-api-key";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError, ApiError } from "@/lib/api-error";
import { newTraceId, logger } from "@/lib/logger";
import { ensureToolsRegistered } from "@/lib/tools/bootstrap";
import { toolRegistry } from "@/lib/tools/registry";
import { RunToolRequestSchema, RunToolResponseSchema } from "@/contracts/public-api";

type Params = { params: Promise<{ chatId: string }> };

const NON_TERMINAL_RUN_STATUSES = ["QUEUED", "THINKING", "WORKING", "WAITING", "STOPPING"] as const;

/**
 * Direct Magica tool execution — bypasses the LLM entirely. The tool name
 * and input are validated synchronously, right here, so a bad request
 * fails fast with a real 400 instead of dispatching a task that would only
 * fail asynchronously. Same "one active run per chat" rule as a normal
 * turn (see dispatch-turn.ts) — a direct tool call still occupies the
 * chat's one run slot while it's in flight.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const { ownerId } = await requireApiKey(req);

    const chat = await prisma.chat.findFirst({ where: { id: chatId, ownerId, deletedAt: null } });
    if (!chat) throw new NotFoundError("Chat");

    const input = RunToolRequestSchema.parse(await req.json().catch(() => null));

    ensureToolsRegistered();
    const tool = toolRegistry.get(input.toolName);
    if (!tool) throw new ApiError(400, "unknown_tool", `No tool named "${input.toolName}"`);
    const parsedInput = tool.inputSchema.safeParse(input.input);
    if (!parsedInput.success) {
      throw new ApiError(400, "invalid_tool_input", `Invalid input for "${input.toolName}": ${parsedInput.error.message}`);
    }

    const activeRun = await prisma.agentRun.findFirst({
      where: { chatId, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
    });
    if (activeRun) throw new ApiError(409, "run_in_progress", "This chat already has an active run");

    const run = await prisma.agentRun.create({
      data: { chatId, idempotencyKey: crypto.randomUUID(), status: "QUEUED" },
    });

    try {
      const handle = await tasks.trigger("run-tool", {
        agentRunId: run.id,
        toolName: input.toolName,
        input: parsedInput.data,
      });
      await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId: handle.id } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to dispatch the tool call";
      logger.error(message, { traceId, chatId, runId: run.id, toolName: input.toolName });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", endedAt: new Date(), error: { code: "dispatch_failed", message } },
      });
      throw new ApiError(502, "dispatch_failed", "Failed to start this tool call — please try again");
    }

    const body = RunToolResponseSchema.parse({
      id: run.id,
      chatId,
      status: "QUEUED",
      createdAt: run.createdAt.toISOString(),
    });
    return NextResponse.json(body, { status: 202 });
  });
}
