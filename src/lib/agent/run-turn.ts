import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { streamChatCompletion, OpenRouterError, type OpenRouterMessage, type OpenRouterToolCall } from "@/lib/openrouter";
import { toolRegistry } from "@/lib/tools/registry";
import { ensureToolsRegistered } from "@/lib/tools/bootstrap";
import { executeToolCall, type TurnApprovalState } from "./execute-tool-call";
import { getSkillsRegistry } from "@/lib/skills/registry";
import { waitUntil } from "@trigger.dev/sdk";
import { dispatchWebhookEvent } from "@/lib/webhooks/dispatch";
import type { MessageContent } from "@/contracts/content-blocks";
import type { ToolStreamEvent } from "@/contracts/tool-stream";
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

export interface RunTurnOptions {
  isFinalAttempt: boolean;
}

/**
 * Cooperative cancellation: POST /api/runs/[runId]/cancel flips the row to
 * STOPPING and this is where the task notices. Deliberately not
 * Trigger.dev's own runs.cancel() — a hard kill mid-tool-call would strand
 * a Magica job we'd already paid for and lose the partial answer. Checked
 * only between steps, so the worst case is one in-flight tool call (or one
 * model response) finishing before the turn winds down.
 */
async function isStopRequested(runId: string): Promise<boolean> {
  const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } });
  return run?.status === "STOPPING";
}

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
  onToolEvent?: (event: ToolStreamEvent) => void,
  options: RunTurnOptions = { isFinalAttempt: true },
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

  // Never awaited — a slow or dead webhook receiver must not add latency to
  // (or fail) the turn it's reporting on. But a bare `void` isn't enough
  // inside a task: an unawaited promise dies with the execution context when
  // the task function returns. waitUntil keeps the run alive until delivery
  // settles without blocking the work in between. Confirmed live before
  // adding it — agent.started (fired early, with the whole turn still to run
  // behind it) delivered fine, while agent.completed (fired just before the
  // function returns) never arrived at all.
  waitUntil(dispatchWebhookEvent(ownerId, "agent.started", { runId, chatId: run.chatId }));

  const previousAssistantMessage = await prisma.message.findFirst({
    where: { chatId: run.chatId, runId, role: "ASSISTANT" },
    orderBy: { createdAt: "desc" },
  });
  const assistantMessage = previousAssistantMessage
    ? await prisma.message.update({
        where: { id: previousAssistantMessage.id },
        data: { status: "STREAMING", content: [] },
      })
    : await prisma.message.create({
        data: { chatId: run.chatId, runId, role: "ASSISTANT", status: "STREAMING", content: [] },
      });

  const contentBlocks: MessageContent = [];
  let toolSequence = 0;
  let finalModel: string | null = null;
  let cancelled = false;
  // One object for the whole turn — "approve all" flips it once and every
  // later paid call in this loop skips its gate.
  const approvalState: TurnApprovalState = { approveAll: false };

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (await isStopRequested(runId)) {
        cancelled = true;
        break;
      }

      const result = await streamChatCompletion(orMessages, {
        tools: toolRegistry.toOpenRouterTools(),
        onTextDelta,
      });
      finalModel = result.model ?? finalModel;

      if (result.fullText) {
        contentBlocks.push({ type: "text", text: result.fullText });
      }

      // Checked before either exit from this iteration — a Stop pressed
      // while the model was mid-response must be reflected in the run's
      // own terminal status even when the model happened to land on a
      // final answer right as it landed, not just when there were more
      // tool calls left to skip.
      if (await isStopRequested(runId)) {
        cancelled = true;
        break;
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
      //
      // Each call emits its own started/finished tool-stream events as
      // soon as *that* call reaches each point, rather than waiting for
      // every call in this batch to finish — otherwise a fast crop_image
      // running alongside a slow generate_image would have its own
      // "finished" event held back by the slower one.
      const executed = await Promise.all(
        result.toolCalls.map(async (tc, i) => {
          onToolEvent?.({
            kind: "started",
            block: { type: "tool_use", id: tc.id, toolName: tc.name, input: undefined },
          });
          const outcome = await executeToolCall(
            { id: tc.id, name: tc.name, arguments: tc.arguments },
            toolSequence + i,
            { runId, chatId: run.chatId, ownerId },
            { approvalState, onApprovalEvent: onToolEvent },
          );
          onToolEvent?.({ kind: "finished", block: outcome.toolUseBlock, result: outcome.toolResultBlock });
          return outcome;
        }),
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

    // A stopped turn keeps whatever it had already produced — the partial
    // text and any tool calls that already completed (and were already
    // charged for) stay on the message rather than being thrown away.
    await prisma.$transaction([
      prisma.message.update({
        where: { id: assistantMessage.id },
        data: { status: cancelled ? "CANCELLED" : "COMPLETE", content: asJsonInput(contentBlocks) },
      }),
      prisma.agentRun.update({
        where: { id: runId },
        data: {
          status: cancelled ? "CANCELLED" : "COMPLETE",
          endedAt: new Date(),
          model: finalModel,
        },
      }),
    ]);

    waitUntil(
      dispatchWebhookEvent(ownerId, "agent.completed", {
        runId,
        chatId: run.chatId,
        status: cancelled ? "CANCELLED" : "COMPLETE",
        messageId: assistantMessage.id,
      }),
    );
  } catch (err) {
    // Persisted structured, not as a bare string — the UI has to be able to
    // explain a failed turn on its own ("rate limited, try again shortly"
    // reads very differently from a raw 429 dump), and `code` is what it
    // branches on.
    const code = err instanceof OpenRouterError ? err.code : "unknown";
    const message = err instanceof Error ? err.message : "Agent turn failed";
    logger.error(message, { runId, chatId: run.chatId, messageId: assistantMessage.id, code });

    if (options.isFinalAttempt) {
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

      waitUntil(dispatchWebhookEvent(ownerId, "agent.failed", { runId, chatId: run.chatId, code, message }));
    }

    throw err;
  }
}
