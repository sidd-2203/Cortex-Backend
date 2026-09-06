import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { streamChatCompletion, OpenRouterError, type OpenRouterMessage, type OpenRouterToolCall } from "@/lib/openrouter";
import { toolRegistry } from "@/lib/tools/registry";
import { ensureToolsRegistered } from "@/lib/tools/bootstrap";
import { executeToolCall } from "./execute-tool-call";
import { getSkillsRegistry } from "@/lib/skills/registry";
import type { MessageContent } from "@/contracts/content-blocks";
import type { Prisma } from "../../../prisma/generated/prisma/client";

// Content blocks are already validated by ContentBlockSchema wherever they're
// constructed; this cast only tells Prisma's Json input type (which can't
// express our discriminated union) to accept the value as-is.
function asJsonInput(content: MessageContent): Prisma.InputJsonValue {
  return content as unknown as Prisma.InputJsonValue;
}

const HISTORY_LIMIT = 50;
// A hard ceiling on model <-> tool round-trips within one turn. Without
// this, a model stuck calling the same tool over and over (or two tools
// that keep triggering each other) would run forever instead of failing
// loudly.
const MAX_TOOL_ITERATIONS = 6;

/**
 * Executes one agent turn: loads recent chat history, runs the model <->
 * tool loop against OpenRouter Free, persists the assistant message (as
 * ordered content blocks — text and any tool_use/tool_result pairs), and
 * settles the run's terminal status. Runs inside the "agent-turn"
 * Trigger.dev task (src/trigger/agent-turn.ts), which pipes each
 * `onTextDelta` chunk to a Realtime stream the frontend subscribes to
 * directly — the route handler that dispatches this never waits on it.
 */
export async function runTurn(
  runId: string,
  onTextDelta?: (delta: string) => void,
): Promise<void> {
  ensureToolsRegistered();
  const run = await prisma.agentRun.findUniqueOrThrow({
    where: { id: runId },
    include: { chat: { select: { ownerId: true } } },
  });
  const ownerId = run.chat.ownerId;

  const history = await prisma.message.findMany({
    where: { chatId: run.chatId, status: "COMPLETE" },
    orderBy: { createdAt: "asc" },
    take: HISTORY_LIMIT,
  });

  // Only text (and attachment references, as a plain-text mention of their
  // URL) survives into replayed context — a past turn's own tool_use/
  // tool_result exchange already resolved into its final text and isn't a
  // valid standalone tool_calls/tool-role pair outside the single request
  // it happened in, so it isn't reconstructed here. Attachments aren't sent
  // as multimodal content (most free OpenRouter models don't support it
  // reliably) — the model sees the URL as text and can pass it into a tool
  // call itself (e.g. crop_image's imageUrl) if it needs to act on it.
  const orMessages: OpenRouterMessage[] = history.map((m) => ({
    role: m.role === "USER" ? "user" : m.role === "SYSTEM" ? "system" : "assistant",
    content: (m.content as MessageContent)
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "attachment") return `[Attached ${b.attachmentType.toLowerCase()}: ${b.url}]`;
        return null;
      })
      .filter((s): s is string => s !== null)
      .join("\n"),
  }));

  // Skills are "exposed to the model only as name + description" per the
  // design — this system message is that exposure. Full guidance is never
  // in context up front; the model pulls it in on demand via load_skill.
  const skills = getSkillsRegistry().list();
  if (skills.length > 0) {
    const skillsList = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    orMessages.unshift({
      role: "system",
      content: `You have access to these skills. Call load_skill with a skill's name to load its full guidance before relying on it:\n${skillsList}`,
    });
  }

  await prisma.agentRun.update({
    where: { id: runId },
    data: { status: "WORKING", startedAt: new Date() },
  });

  const assistantMessage = await prisma.message.create({
    data: { chatId: run.chatId, runId, role: "ASSISTANT", status: "STREAMING", content: [] },
  });

  const contentBlocks: MessageContent = [];
  let toolSequence = 0;
  let finalModel: string | null = null;

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const result = await streamChatCompletion(orMessages, {
        tools: toolRegistry.toOpenRouterTools(),
        onTextDelta,
      });
      finalModel = result.model ?? finalModel;

      if (result.fullText) {
        contentBlocks.push({ type: "text", text: result.fullText });
      }

      if (result.toolCalls.length === 0) {
        break; // model gave a final answer — no more tool calls requested
      }

      const toolCalls: OpenRouterToolCall[] = result.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
      orMessages.push({ role: "assistant", content: result.fullText, tool_calls: toolCalls });

      // Executed concurrently (Promise.all preserves the array's original
      // order in its results regardless of which finishes first), but the
      // content blocks and tool-role messages below are appended in the
      // model's original request order — deterministic either way.
      const executed = await Promise.all(
        result.toolCalls.map((tc, i) =>
          executeToolCall(
            { id: tc.id, name: tc.name, arguments: tc.arguments },
            toolSequence + i,
            { runId, chatId: run.chatId, ownerId },
          ),
        ),
      );
      toolSequence += executed.length;

      for (const { toolUseBlock, toolResultBlock, resultForModel } of executed) {
        contentBlocks.push(toolUseBlock, toolResultBlock);
        orMessages.push({
          role: "tool",
          tool_call_id: toolUseBlock.id,
          content: resultForModel,
        });
      }
    }

    await prisma.$transaction([
      prisma.message.update({
        where: { id: assistantMessage.id },
        data: { status: "COMPLETE", content: asJsonInput(contentBlocks) },
      }),
      prisma.agentRun.update({
        where: { id: runId },
        data: { status: "COMPLETE", endedAt: new Date(), model: finalModel },
      }),
    ]);
  } catch (err) {
    // Persisted structured, not as a bare string — the UI has to be able to
    // explain a failed turn on its own ("rate limited, try again shortly"
    // reads very differently from a raw 429 dump), and `code` is what it
    // branches on.
    const code = err instanceof OpenRouterError ? err.code : "unknown";
    const message = err instanceof Error ? err.message : "Agent turn failed";
    logger.error(message, { runId, chatId: run.chatId, messageId: assistantMessage.id, code });

    await prisma.$transaction([
      prisma.message.update({
        where: { id: assistantMessage.id },
        data: { status: "FAILED", content: asJsonInput(contentBlocks) },
      }),
      prisma.agentRun.update({
        where: { id: runId },
        data: { status: "FAILED", endedAt: new Date(), error: { code, message } },
      }),
    ]);
    throw err;
  }
}
