import { NextRequest, NextResponse } from "next/server";
import { tasks, auth as triggerAuth } from "@trigger.dev/sdk";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, ApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { serializeMessage } from "@/lib/serialize";
import { encodeCursor, decodeCursor } from "@/lib/cursor";
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

    const { userMessage, run } = await prisma.$transaction(async (tx) => {
      // Auto-title on the first message so the chat list isn't just "New
      // chat" repeated for every entry — checked inside the transaction so
      // a concurrent send-turn on the same brand-new chat can't race this.
      const isFirstMessage = (await tx.message.count({ where: { chatId } })) === 0;
      const title = isFirstMessage ? titleFromContent(input.content) : null;

      const userMessage = await tx.message.create({
        data: { chatId, role: "USER", status: "COMPLETE", content: input.content },
      });
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

    const handle = await tasks.trigger("agent-turn", { agentRunId: run.id });
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
