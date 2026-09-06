import { wait, WaitpointTimeoutError, AbortTaskRunError } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import type { Prisma } from "../../../prisma/generated/prisma/client";

export interface ApprovalDecision {
  approved: boolean;
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
 */
export async function requestApproval(params: {
  runId: string;
  toolName: string;
  input: unknown;
  timeoutSeconds: number;
}): Promise<ApprovalDecision> {
  const token = await wait.createToken({ timeout: `${params.timeoutSeconds}s` });
  const expiresAt = new Date(Date.now() + params.timeoutSeconds * 1000);

  await prisma.waitpoint.create({
    data: {
      runId: params.runId,
      type: "APPROVAL",
      status: "PENDING",
      token: token.id,
      payload: asJson({ toolName: params.toolName, input: params.input }),
      expiresAt,
    },
  });

  try {
    const decision = await wait.forToken<ApprovalDecision>(token).unwrap();
    await prisma.waitpoint.updateMany({
      where: { token: token.id, status: "PENDING" },
      data: { status: "RESOLVED", resolution: asJson(decision), resolvedAt: new Date() },
    });
    return decision;
  } catch (err) {
    if (err instanceof WaitpointTimeoutError) {
      await prisma.waitpoint.updateMany({
        where: { token: token.id, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
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
