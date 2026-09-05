import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { streamChatCompletion, OpenRouterError, type OpenRouterMessage } from "@/lib/openrouter";
import type { MessageContent } from "@/contracts/content-blocks";
import type { Prisma } from "../../../prisma/generated/prisma/client";

// Content blocks are already validated by ContentBlockSchema wherever they're
// constructed; this cast only tells Prisma's Json input type (which can't
// express our discriminated union) to accept the value as-is.
function asJsonInput(content: MessageContent): Prisma.InputJsonValue {
  return content as unknown as Prisma.InputJsonValue;
}

const HISTORY_LIMIT = 50;

/**
 * Executes one agent turn: loads recent chat history, calls OpenRouter Free,
 * persists the streamed assistant message, and settles the run's terminal
 * status. Runs inside the "agent-turn" Trigger.dev task
 * (src/trigger/agent-turn.ts), which pipes each `onTextDelta` chunk to a
 * Realtime stream the frontend subscribes to directly — the route handler
 * that dispatches this never waits on it.
 */
export async function runTurn(
  runId: string,
  onTextDelta?: (delta: string) => void,
): Promise<void> {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } });

  const history = await prisma.message.findMany({
    where: { chatId: run.chatId, status: "COMPLETE" },
    orderBy: { createdAt: "asc" },
    take: HISTORY_LIMIT,
  });

  const orMessages: OpenRouterMessage[] = history.map((m) => ({
    role: m.role === "USER" ? "user" : m.role === "SYSTEM" ? "system" : "assistant",
    content: (m.content as MessageContent)
      .filter((b): b is Extract<MessageContent[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
  }));

  await prisma.agentRun.update({
    where: { id: runId },
    data: { status: "WORKING", startedAt: new Date() },
  });

  const assistantMessage = await prisma.message.create({
    data: { chatId: run.chatId, runId, role: "ASSISTANT", status: "STREAMING", content: [] },
  });

  try {
    const result = await streamChatCompletion(orMessages, { onTextDelta });

    const content: MessageContent = result.fullText ? [{ type: "text", text: result.fullText }] : [];

    await prisma.$transaction([
      prisma.message.update({
        where: { id: assistantMessage.id },
        data: { status: "COMPLETE", content: asJsonInput(content) },
      }),
      prisma.agentRun.update({
        where: { id: runId },
        data: { status: "COMPLETE", endedAt: new Date(), model: result.model },
      }),
    ]);
  } catch (err) {
    const message = err instanceof OpenRouterError ? err.message : "Agent turn failed";
    logger.error(message, { runId, chatId: run.chatId, messageId: assistantMessage.id });

    await prisma.$transaction([
      prisma.message.update({
        where: { id: assistantMessage.id },
        data: { status: "FAILED", content: [] },
      }),
      prisma.agentRun.update({
        where: { id: runId },
        data: { status: "FAILED", endedAt: new Date(), error: { message } },
      }),
    ]);
    throw err;
  }
}
