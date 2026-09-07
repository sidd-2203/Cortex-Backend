import { wait, WaitpointTimeoutError, AbortTaskRunError } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { ToolStreamEvent } from "@/contracts/tool-stream";
import type { Prisma } from "../../../prisma/generated/prisma/client";

export interface ApprovalDecision {
  approved: boolean;
  /** "Stop asking for the rest of this turn" — the caller's loop carries this, not us. */
  approveAll?: boolean;
  comment?: string;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

/**
 * Pauses the current run on a human approval gate. Must be called from
 * inside a task (wait.forToken() requires it) — see execute-tool-call.ts,
 * which calls this before running any tool with `requiresApproval: true`.
 *
 * Trigger.dev's waitpoint token is the actual durable pause/resume
 * primitive; our own Waitpoint row is the record of it (what
 * POST /api/waitpoints/[token]/resolve reads/writes) and the audit trail
 * ("recorded per run" — the same durability requirement RunSkill exists
 * for). Both the resolve route and this function's own continuation write
 * the terminal status, and both do it as a PENDING -> terminal conditional
 * update, so whichever gets there first wins and the other is a no-op —
 * that's what "tolerating duplicate submissions" means in practice here.
 *
 * `onEvent` puts the same pause on the "tool" Realtime stream, which is the
 * only reason the UI can show an approval card the instant the run parks
 * rather than the user staring at a spinner until it times out.
 */
export async function requestApproval(params: {
  runId: string;
  toolUseId: string;
  toolName: string;
  input: unknown;
  cost: number;
  timeoutSeconds: number;
  onEvent?: (event: ToolStreamEvent) => void;
}): Promise<ApprovalDecision> {
  const token = await wait.createToken({ timeout: `${params.timeoutSeconds}s` });
  const expiresAt = new Date(Date.now() + params.timeoutSeconds * 1000);

  await prisma.waitpoint.create({
    data: {
      runId: params.runId,
      type: "APPROVAL",
      status: "PENDING",
      token: token.id,
      payload: asJson({ toolName: params.toolName, input: params.input, cost: params.cost }),
      expiresAt,
    },
  });

  // WAITING is the honest status while parked — distinct from WORKING, and
  // what a "this run is blocked on you" view would read. Conditional on
  // WORKING so it can't overwrite a STOPPING that a cancel just set.
  await prisma.agentRun.updateMany({
    where: { id: params.runId, status: "WORKING" },
    data: { status: "WAITING" },
  });

  logger.info("approval requested", {
    runId: params.runId,
    waitpointTokenId: token.id,
    toolName: params.toolName,
    cost: params.cost,
  });

  params.onEvent?.({
    kind: "approval_required",
    token: token.id,
    toolUseId: params.toolUseId,
    toolName: params.toolName,
    input: params.input,
    cost: params.cost,
    expiresAt: expiresAt.toISOString(),
  });

  try {
    const decision = await wait.forToken<ApprovalDecision>(token).unwrap();
    await prisma.waitpoint.updateMany({
      where: { token: token.id, status: "PENDING" },
      data: { status: "RESOLVED", resolution: asJson(decision), resolvedAt: new Date() },
    });
    // Back to WORKING only from WAITING — a cancel that landed while we were
    // parked leaves the run in STOPPING, and un-cancelling it here would
    // silently defeat the Stop button.
    await prisma.agentRun.updateMany({
      where: { id: params.runId, status: "WAITING" },
      data: { status: "WORKING" },
    });
    logger.info("approval resolved", {
      runId: params.runId,
      waitpointTokenId: token.id,
      toolName: params.toolName,
      approved: decision.approved,
      approveAll: decision.approveAll ?? false,
    });
    params.onEvent?.({ kind: "approval_resolved", token: token.id, approved: decision.approved });
    return decision;
  } catch (err) {
    if (err instanceof WaitpointTimeoutError) {
      await prisma.waitpoint.updateMany({
        where: { token: token.id, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
      logger.warn("approval expired unanswered", {
        runId: params.runId,
        waitpointTokenId: token.id,
        toolName: params.toolName,
        timeoutSeconds: params.timeoutSeconds,
      });
      params.onEvent?.({ kind: "approval_resolved", token: token.id, approved: false });
      // AbortTaskRunError specifically, not a plain Error: confirmed by
      // testing that a plain throw here gets caught by Trigger.dev's
      // default task-level retry policy, which re-runs this function from
      // scratch — creating a SECOND waitpoint token (and a third, per
      // maxAttempts) for what should be one expired approval. A timed-out
      // human decision isn't a transient failure worth retrying; execute-
      // tool-call.ts already converts this into a graceful isError
      // tool_result without retrying either way, but this holds even if a
      // future caller invokes requestApproval without that same try/catch.
      throw new AbortTaskRunError(
        `Approval for "${params.toolName}" timed out after ${params.timeoutSeconds}s — no response`,
      );
    }
    throw err;
  }
}
