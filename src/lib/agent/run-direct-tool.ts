import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { ensureToolsRegistered } from "@/lib/tools/bootstrap";
import { executeToolCall } from "./execute-tool-call";

/**
 * Runs exactly one tool call, outside the LLM loop entirely — the
 * public-API "direct tool execution" endpoint's Trigger.dev task body (see
 * src/trigger/run-tool.ts). `toolName`/`input` come straight from the
 * dispatch payload rather than being read off the AgentRun row: a direct
 * call doesn't need a place in the schema to stash them, the task payload
 * already is one.
 *
 * approveAll: true from the start — this call *is* the approval. The
 * approval gate exists to stop a model from autonomously deciding to spend
 * credits; here a developer, authenticated by their own API key, named
 * this exact tool and these exact arguments on purpose.
 */
export async function runDirectToolCall(params: { runId: string; toolName: string; input: unknown }): Promise<void> {
  ensureToolsRegistered();
  const { runId, toolName, input } = params;

  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: { chat: { select: { ownerId: true } } },
  });
  const ownerId = run.chat.ownerId;

  await prisma.agentRun.update({ where: { id: runId }, data: { status: "WORKING", startedAt: new Date() } });

  try {
    // executeToolCall never throws for a bad tool name or invalid input —
    // both become a normal isError result — so this try/catch is only for
    // genuinely unexpected failures (e.g. a database error), which still
    // need to mark the run FAILED rather than leaving it stuck WORKING.
    const outcome = await executeToolCall(
      { id: `direct_${runId}`, name: toolName, arguments: JSON.stringify(input) },
      0,
      { runId, chatId: run.chatId, ownerId },
      { approvalState: { approveAll: true } },
    );

    const isError = outcome.toolResultBlock.isError;
    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: isError ? "FAILED" : "COMPLETE",
        endedAt: new Date(),
        error: isError ? { code: "tool_failed", message: outcome.resultForModel } : undefined,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Direct tool call failed";
    logger.error(message, { runId, toolName });
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: "FAILED", endedAt: new Date(), error: { code: "unknown", message } },
    });
    throw err;
  }
}
