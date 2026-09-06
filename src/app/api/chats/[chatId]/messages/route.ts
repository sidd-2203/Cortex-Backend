import { NextRequest, NextResponse } from "next/server";
import { tasks, auth as triggerAuth } from "@trigger.dev/sdk";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, ApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { serializeMessage } from "@/lib/serialize";
import { encodeCursor, decodeCursor } from "@/lib/cursor";
import type { AttachmentBlock, ContentBlock } from "@/contracts/content-blocks";
import type { Prisma } from "../../../../../../prisma/generated/prisma/client";
import {
  SendTurnRequestSchema,
  SendTurnResponseSchema,
  CursorPageRequestSchema,
  cursorPageResponseSchema,
  MessageSchema,
} from "@/contracts/chat";

type Params = { params: Promise<{ chatId: string }> };

const NON_TERMINAL_RUN_STATUSES = ["QUEUED", "THINKING", "WORKING", "WAITING", "STOPPING"] as const;

/** First text block, single line, capped — good enough for a list label. */
function titleFromContent(content: { type: string; text?: string }[]): string | null {
  const text = content.find((b) => b.type === "text")?.text;
  if (!text) return null;
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 60 ? `${singleLine.slice(0, 60)}…` : singleLine;
}

async function requireOwnedChat(chatId: string, ownerId: string) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, ownerId, deletedAt: null } });
  if (!chat) throw new NotFoundError("Chat");
  return chat;
}

/**
 * Resolves attachmentIds into content blocks, or throws — a caller citing
 * an attachment that isn't theirs, isn't finished uploading, or is already
 * attached to a different message is a bug in the client, not something to
 * silently drop, so this fails the whole send rather than sending a
 * half-attached message.
 */
async function resolveAttachmentBlocks(attachmentIds: string[], ownerId: string): Promise<AttachmentBlock[]> {
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

export async function GET(req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const user = await requireUser();
    await requireOwnedChat(chatId, user.id);

    const { searchParams } = new URL(req.url);
    const { cursor, limit } = CursorPageRequestSchema.parse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const decoded = cursor ? decodeCursor(cursor) : null;

    // Newest-first for the initial load; the frontend reverses for display
    // and walks `nextCursor` backwards as the user scrolls up.
    const messages = await prisma.message.findMany({
      where: {
        chatId,
        ...(decoded
          ? {
              OR: [
                { createdAt: { lt: decoded.timestamp } },
                { createdAt: decoded.timestamp, id: { lt: decoded.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor =
      hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null;

    const body = cursorPageResponseSchema(MessageSchema).parse({
      items: page.map(serializeMessage),
      nextCursor,
    });
    return NextResponse.json(body);
  });
}

/**
 * Send-turn: validate → persist the user's message → dispatch a durable
 * Trigger.dev task → return a subscription the frontend uses to read the
 * response directly from Trigger.dev Realtime. This handler never waits on
 * the LLM completion — it dispatches and returns, which is what keeps it
 * comfortably inside Vercel's serverless function time limit regardless of
 * how long the actual response takes to stream.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const user = await requireUser();
    await requireOwnedChat(chatId, user.id);

    const input = SendTurnRequestSchema.parse(await req.json().catch(() => null));

    // Idempotent dispatch: a retried send for a key we've already dispatched
    // returns a fresh subscription to the SAME run rather than creating a
    // duplicate — this must survive network retries and double-clicks. The
    // original trigger-time token isn't persisted (short-lived by design),
    // so a retry mints a new one scoped to the existing run.
    const existingRun = await prisma.agentRun.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existingRun) {
      if (!existingRun.triggerRunId) {
        throw new ApiError(409, "dispatch_in_progress", "This turn is still being dispatched, retry shortly");
      }
      const existingMessage = await prisma.message.findFirst({ where: { runId: existingRun.id, role: "USER" } });
      const publicAccessToken = await triggerAuth.createPublicToken({
        scopes: { read: { runs: [existingRun.triggerRunId] } },
      });
      const body = SendTurnResponseSchema.parse({
        chatId,
        messageId: existingMessage?.id ?? existingRun.id,
        runId: existingRun.id,
        triggerRunId: existingRun.triggerRunId,
        publicAccessToken,
      });
      return NextResponse.json(body, { status: 200 });
    }

    // One active run per chat, enforced here (and backstopped by a partial
    // unique index once one exists — see prisma/schema.prisma) before we
    // ever dispatch a task.
    const activeRun = await prisma.agentRun.findFirst({
      where: { chatId, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
    });
    if (activeRun) {
      throw new ApiError(409, "run_in_progress", "This chat already has an active run");
    }

    // Resolved outside the transaction (read-only lookup) — the "not
    // already attached elsewhere" race is what the transaction actually
    // needs to guard, via the conditional updateMany below.
    const attachmentBlocks = await resolveAttachmentBlocks(input.attachmentIds, user.id);
    const content: ContentBlock[] = [...input.content, ...attachmentBlocks];

    const { userMessage, run } = await prisma.$transaction(async (tx) => {
      // Auto-title on the first message so the chat list isn't just "New
      // chat" repeated for every entry — checked inside the transaction so
      // a concurrent send-turn on the same brand-new chat can't race this.
      const isFirstMessage = (await tx.message.count({ where: { chatId } })) === 0;
      const title = isFirstMessage ? titleFromContent(input.content) : null;

      const userMessage = await tx.message.create({
        data: { chatId, role: "USER", status: "COMPLETE", content: content as unknown as Prisma.InputJsonValue },
      });

      if (attachmentBlocks.length > 0) {
        // updateMany's `messageId: null` guard is the actual race backstop:
        // if two concurrent sends both resolved the same attachment as free,
        // only one of these updates a row — count comes back short and this
        // send fails rather than silently stealing an attachment already
        // claimed by the other.
        const { count } = await tx.attachment.updateMany({
          where: { id: { in: attachmentBlocks.map((b) => b.attachmentId) }, messageId: null },
          data: { messageId: userMessage.id },
        });
        if (count !== attachmentBlocks.length) {
          throw new ApiError(409, "attachment_race", "One or more attachments were claimed by another message");
        }
      }

      const run = await tx.agentRun.create({
        data: { chatId, idempotencyKey: input.idempotencyKey, status: "QUEUED" },
      });
      // Bumps Chat.updatedAt too (Prisma's @updatedAt fires on any
      // update()), which is what keeps the sidebar's most-recent-first
      // ordering honest — creating a Message doesn't touch its parent
      // Chat's timestamp on its own.
      await tx.chat.update({ where: { id: chatId }, data: title ? { title } : {} });
      return { userMessage, run };
    });

    // If dispatch itself throws (a real incident: Trigger.dev unreachable,
    // misconfigured, whatever), the run created above must not be left
    // QUEUED with no triggerRunId — NON_TERMINAL_RUN_STATUSES treats QUEUED
    // as active, so an un-dispatched run in that state blocks every future
    // send on this chat forever, with nothing left to ever resolve it. Mark
    // it FAILED so the one-active-run-per-chat check clears and the next
    // send can go through.
    let handle: Awaited<ReturnType<typeof tasks.trigger>>;
    try {
      handle = await tasks.trigger("agent-turn", { agentRunId: run.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to dispatch the run";
      // A FAILED assistant message, not just a FAILED run row, is what
      // makes this visible after a reload — runTurn's own failure path
      // already creates one for a mid-turn crash (see run-turn.ts), so the
      // frontend's `status === "FAILED"` rendering already exists and just
      // needs a row to render for a dispatch-time failure too. Without
      // this, a reload shows the user's message with silence: nothing ever
      // gets created here otherwise, since runTurn (which normally creates
      // the assistant message) never got to run at all.
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

    const body = SendTurnResponseSchema.parse({
      chatId,
      messageId: userMessage.id,
      runId: run.id,
      triggerRunId: handle.id,
      publicAccessToken: handle.publicAccessToken,
    });
    return NextResponse.json(body, { status: 201 });
  });
}
