import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth-api-key";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { serializeMessage } from "@/lib/serialize";
import { encodeCursor, decodeCursor } from "@/lib/cursor";
import { dispatchTurn } from "@/lib/agent/dispatch-turn";
import { CursorPageRequestSchema, cursorPageResponseSchema, MessageSchema } from "@/contracts/chat";
import { CreateMessageRequestSchema, CreateMessageResponseSchema } from "@/contracts/public-api";

type Params = { params: Promise<{ chatId: string }> };

async function requireOwnedChat(chatId: string, ownerId: string) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, ownerId, deletedAt: null } });
  if (!chat) throw new NotFoundError("Chat");
  return chat;
}

/** Conversation reads: this chat's messages, newest-first, cursor-paginated. */
export async function GET(req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const { ownerId } = await requireApiKey(req);
    await requireOwnedChat(chatId, ownerId);

    const { searchParams } = new URL(req.url);
    const { cursor, limit } = CursorPageRequestSchema.parse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const decoded = cursor ? decodeCursor(cursor) : null;

    const messages = await prisma.message.findMany({
      where: {
        chatId,
        ...(decoded
          ? { OR: [{ createdAt: { lt: decoded.timestamp } }, { createdAt: decoded.timestamp, id: { lt: decoded.id } }] }
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
 * Message submission: append a message to an existing chat and dispatch a
 * turn — the public-API equivalent of the first-party send-turn route,
 * minus the Trigger.dev Realtime subscription details (those are an
 * implementation detail of the first-party frontend, not part of this
 * surface). Poll GET /api/v1/runs/:runId or register a webhook instead.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const { ownerId } = await requireApiKey(req);
    await requireOwnedChat(chatId, ownerId);

    const input = CreateMessageRequestSchema.parse(await req.json().catch(() => null));

    const dispatched = await dispatchTurn({
      chatId,
      ownerId,
      // A public-API caller has no client-generated idempotency key of its
      // own to send — derived from the request's own content instead isn't
      // safe (two genuinely different messages could collide), so each
      // call here is its own dispatch. A caller that needs retry-safety
      // should check GET /api/v1/runs/:runId for an in-flight run on this
      // chat before retrying, same as the one-run-per-chat rule already
      // enforces server-side.
      idempotencyKey: crypto.randomUUID(),
      content: [{ type: "text", text: input.content }],
      attachmentIds: input.attachmentIds,
    });

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: dispatched.runId } });

    const body = CreateMessageResponseSchema.parse({
      id: dispatched.userMessageId,
      runId: dispatched.runId,
      chatId,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
    });
    return NextResponse.json(body, { status: dispatched.isNew ? 201 : 200 });
  });
}
