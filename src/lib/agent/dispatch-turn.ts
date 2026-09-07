import { tasks } from "@trigger.dev/sdk";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api-error";
import type { AttachmentBlock, ContentBlock } from "@/contracts/content-blocks";
import type { Prisma } from "../../../prisma/generated/prisma/client";

const NON_TERMINAL_RUN_STATUSES = ["QUEUED", "THINKING", "WORKING", "WAITING", "STOPPING"] as const;

/** First text block, single line, capped — good enough for a list label. */
function titleFromContent(content: { type: string; text?: string }[]): string | null {
  const text = content.find((b) => b.type === "text")?.text;
  if (!text) return null;
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 60 ? `${singleLine.slice(0, 60)}…` : singleLine;
}

/**
 * Resolves attachmentIds into content blocks, or throws — a caller citing
 * an attachment that isn't theirs, isn't finished uploading, or is already
 * attached to a different message is a bug in the client, not something to
 * silently drop, so this fails the whole send rather than sending a
 * half-attached message.
 */
export async function resolveAttachmentBlocks(attachmentIds: string[], ownerId: string): Promise<AttachmentBlock[]> {
  if (attachmentIds.length === 0) return [];

  const attachments = await prisma.attachment.findMany({ where: { id: { in: attachmentIds }, ownerId } });
  const byId = new Map(attachments.map((a) => [a.id, a]));

  return attachmentIds.map((id) => {
    const attachment = byId.get(id);
    if (!attachment) throw new ApiError(400, "invalid_attachment", `Attachment ${id} not found`);
    if (attachment.status !== "READY" || !attachment.url) {
      throw new ApiError(400, "attachment_not_ready", `Attachment ${id} has not finished uploading`);
    }
    if (attachment.messageId) {
      throw new ApiError(400, "attachment_already_used", `Attachment ${id} is already attached to another message`);
    }
    return {
      type: "attachment",
      attachmentId: attachment.id,
      attachmentType: attachment.type,
      url: attachment.url,
      filename: null,
    };
  });
}

export interface DispatchedTurn {
  userMessageId: string;
  runId: string;
  triggerRunId: string;
  /** false on an idempotent-retry hit (the run already existed) — callers use this to pick 200 vs 201. */
  isNew: boolean;
}

/**
 * The one true "start a turn" path — persist the user's message, create
 * its AgentRun, dispatch the durable Trigger.dev task, and handle a
 * dispatch-time failure so the run never gets stuck QUEUED with nothing
 * left to ever resolve it. Shared by the first-party send-turn route and
 * every /api/v1 route that starts a turn (message submission, chat
 * completions), so this delicate error handling exists exactly once.
 *
 * Idempotent on `idempotencyKey`: a retried call for a key that's already
 * been dispatched returns that same run instead of creating a second one.
 * Not idempotent on a key still mid-dispatch (no triggerRunId yet) — that's
 * a real race the caller should surface as "retry shortly," not silently
 * paper over.
 */
export async function dispatchTurn(params: {
  chatId: string;
  ownerId: string;
  idempotencyKey: string;
  content: ContentBlock[];
  attachmentIds?: string[];
}): Promise<DispatchedTurn> {
  const { chatId, ownerId, idempotencyKey } = params;

  const existingRun = await prisma.agentRun.findUnique({ where: { idempotencyKey } });
  if (existingRun) {
    if (!existingRun.triggerRunId) {
      throw new ApiError(409, "dispatch_in_progress", "This turn is still being dispatched, retry shortly");
    }
    const existingMessage = await prisma.message.findFirst({ where: { runId: existingRun.id, role: "USER" } });
    return {
      userMessageId: existingMessage?.id ?? existingRun.id,
      runId: existingRun.id,
      triggerRunId: existingRun.triggerRunId,
      isNew: false,
    };
  }

  const activeRun = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
  });
  if (activeRun) {
    throw new ApiError(409, "run_in_progress", "This chat already has an active run");
  }

  const attachmentBlocks = await resolveAttachmentBlocks(params.attachmentIds ?? [], ownerId);
  const content: ContentBlock[] = [...params.content, ...attachmentBlocks];

  const { userMessage, run } = await prisma.$transaction(async (tx) => {
    const isFirstMessage = (await tx.message.count({ where: { chatId } })) === 0;
    const title = isFirstMessage ? titleFromContent(params.content) : null;

    const userMessage = await tx.message.create({
      data: { chatId, role: "USER", status: "COMPLETE", content: content as unknown as Prisma.InputJsonValue },
    });

    if (attachmentBlocks.length > 0) {
      const { count } = await tx.attachment.updateMany({
        where: { id: { in: attachmentBlocks.map((b) => b.attachmentId) }, messageId: null },
        data: { messageId: userMessage.id },
      });
      if (count !== attachmentBlocks.length) {
        throw new ApiError(409, "attachment_race", "One or more attachments were claimed by another message");
      }
    }

    const run = await tx.agentRun.create({
      data: { chatId, idempotencyKey, status: "QUEUED" },
    });
    await tx.chat.update({ where: { id: chatId }, data: title ? { title } : {} });
    return { userMessage, run };
  });

  let handle: Awaited<ReturnType<typeof tasks.trigger>>;
  try {
    handle = await tasks.trigger("agent-turn", { agentRunId: run.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to dispatch the run";
    await prisma.$transaction([
      prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", endedAt: new Date(), error: { code: "dispatch_failed", message } },
      }),
      prisma.message.create({
        data: { chatId, runId: run.id, role: "ASSISTANT", status: "FAILED", content: [] },
      }),
    ]);
    throw new ApiError(502, "dispatch_failed", "Failed to start this turn — please try again");
  }
  await prisma.agentRun.update({ where: { id: run.id }, data: { triggerRunId: handle.id } });

  return { userMessageId: userMessage.id, runId: run.id, triggerRunId: handle.id, isNew: true };
}
