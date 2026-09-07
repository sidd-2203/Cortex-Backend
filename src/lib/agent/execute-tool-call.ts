import { z } from "zod";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { toolRegistry } from "@/lib/tools/registry";
import { requireSufficientCredits, settleToolCharge, InsufficientCreditsError } from "@/lib/credits/ledger";
import { requestApproval } from "@/lib/waitpoints/approval";
import type { ToolExecutionContext } from "@/contracts/tools";
import type { ToolUseBlock, ToolResultBlock } from "@/contracts/content-blocks";
import type { ToolStreamEvent } from "@/contracts/tool-stream";
import type { Prisma } from "../../../prisma/generated/prisma/client";

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string; // raw JSON string, as OpenRouter/OpenAI hand it back
}

/**
 * Shared across every tool call in one turn — "approve all" flips this once
 * and every later paid call in the same loop skips its own gate. In-memory
 * on purpose: it dies with the turn, so consent granted for one turn can
 * never leak into the next one.
 */
export interface TurnApprovalState {
  approveAll: boolean;
}

export interface ExecuteToolCallOptions {
  approvalState?: TurnApprovalState;
  onApprovalEvent?: (event: ToolStreamEvent) => void;
}

export interface ExecutedToolCall {
  toolUseBlock: ToolUseBlock;
  toolResultBlock: ToolResultBlock;
  /** What goes back to the model as this tool call's "tool" role message content. */
  resultForModel: string;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * Runs one tool call end to end: parse arguments -> validate against the
 * tool's own input schema -> check credits -> execute -> validate the
 * output -> settle the charge -> record the ToolInvocation. Never throws —
 * a malformed call, an unknown tool, insufficient credits, or a failure
 * inside execute() all become an `isError` tool_result instead, since the
 * model needs to see the failure and can often recover from it (retry with
 * different arguments, apologize, try a different approach) rather than
 * the whole turn dying.
 */
export async function executeToolCall(
  call: ToolCallRequest,
  sequence: number,
  ctx: ToolExecutionContext,
  options?: ExecuteToolCallOptions,
): Promise<ExecutedToolCall> {
  const toolUseBlock: ToolUseBlock = {
    type: "tool_use",
    id: call.id,
    toolName: call.name,
    input: undefined,
  };

  const startedAt = Date.now();
  let status: "SUCCEEDED" | "FAILED" = "SUCCEEDED";
  let input: unknown = null;
  let output: unknown = null;
  let errorMessage: string | null = null;
  let cost = 0;

  try {
    const tool = toolRegistry.get(call.name);
    if (!tool) {
      throw new Error(`Unknown tool: ${call.name}`);
    }
    cost = tool.cost ?? 0;

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(call.arguments);
    } catch {
      throw new Error(`Malformed arguments (not valid JSON): ${call.arguments}`);
    }

    const inputResult = tool.inputSchema.safeParse(parsedArgs);
    if (!inputResult.success) {
      throw new Error(`Invalid arguments: ${z.prettifyError(inputResult.error)}`);
    }
    input = inputResult.data;
    toolUseBlock.input = inputResult.data;

    // Approval gate, before anything else — a human decides whether this
    // call happens at all before we even check whether it can be paid for.
    // Skipped once this turn's "approve all" has been granted.
    if (tool.requiresApproval && !options?.approvalState?.approveAll) {
      const decision = await requestApproval({
        runId: ctx.runId,
        toolUseId: call.id,
        toolName: call.name,
        input: inputResult.data,
        cost,
        timeoutSeconds: tool.approvalTimeoutSeconds ?? 300,
        onEvent: options?.onApprovalEvent,
      });
      // Only an approval can carry consent forward — a denial that happened
      // to arrive with the flag set must not unlock the rest of the turn.
      if (decision.approved && decision.approveAll && options?.approvalState) {
        options.approvalState.approveAll = true;
      }
      if (!decision.approved) {
        throw new Error(`Approval was denied${decision.comment ? `: ${decision.comment}` : ""}`);
      }
    }

    // Pre-flight check — avoids ever starting real (possibly expensive,
    // possibly slow external API) work for a call that can't be paid for.
    // Not itself the enforcement point; settleToolCharge below is what's
    // actually atomic against a concurrent parallel tool call in the same
    // run spending the same balance.
    if (cost > 0) {
      await requireSufficientCredits(ctx.ownerId, cost);
    }

    const rawOutput = await tool.execute(inputResult.data, ctx);
    const outputResult = tool.outputSchema.safeParse(rawOutput);
    if (!outputResult.success) {
      // The tool itself is misbehaving (returning a shape it didn't
      // promise) — this is our bug, not the model's, but it still
      // shouldn't take the whole run down.
      throw new Error(`Tool "${call.name}" returned an invalid output shape`);
    }
    output = outputResult.data;
  } catch (err) {
    status = "FAILED";
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.warn("tool call failed", { runId: ctx.runId, chatId: ctx.chatId, toolName: call.name, error: errorMessage });
  }

  const durationMs = Date.now() - startedAt;

  const invocation = await prisma.toolInvocation.create({
    data: {
      runId: ctx.runId,
      toolName: call.name,
      input: asJson(input ?? { raw: call.arguments }),
      output: status === "SUCCEEDED" ? asJson(output) : asJson({ error: errorMessage }),
      status,
      cost: status === "SUCCEEDED" ? cost : 0,
      durationMs,
      sequence,
    },
  });

  // Settle only on success, and only now that the amount actually charged
  // is tied to a real ToolInvocation row (relatedInvocationId is what
  // makes this idempotent). A race against another parallel tool call in
  // the same run spending the last of the balance between the pre-check
  // above and here flips this call's own result to a failure — the
  // pre-check optimistically assumed the balance would still be there.
  if (status === "SUCCEEDED" && cost > 0) {
    try {
      await settleToolCharge({ ownerId: ctx.ownerId, toolInvocationId: invocation.id, cost });
    } catch (err) {
      if (!(err instanceof InsufficientCreditsError)) throw err;
      status = "FAILED";
      errorMessage = err.message;
      output = null;
      await prisma.toolInvocation.update({
        where: { id: invocation.id },
        data: { status: "FAILED", cost: 0, output: asJson({ error: errorMessage }) },
      });
    }
  }

  const toolResultBlock: ToolResultBlock = {
    type: "tool_result",
    toolUseId: call.id,
    output: status === "SUCCEEDED" ? output : { error: errorMessage },
    isError: status === "FAILED",
    durationMs,
  };

  return {
    toolUseBlock,
    toolResultBlock,
    resultForModel: JSON.stringify(status === "SUCCEEDED" ? output : { error: errorMessage }),
  };
}
