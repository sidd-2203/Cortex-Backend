import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { serializeChat } from "@/lib/serialize";
import { UpdateChatRequestSchema } from "@/contracts/chat";

type Params = { params: Promise<{ chatId: string }> };

/**
 * Ownership check shared by every /api/chats/[chatId]* route. Returns 404
 * (never 403) when the chat belongs to someone else — the existence of
 * another user's chat is not something an authenticated caller should be
 * able to distinguish from "doesn't exist" by probing ids.
 */
async function requireOwnedChat(chatId: string, ownerId: string) {
  const chat = await prisma.chat.findFirst({ where: { id: chatId, ownerId, deletedAt: null } });
  if (!chat) throw new NotFoundError("Chat");
  return chat;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const user = await requireUser();
    const chat = await requireOwnedChat(chatId, user.id);
    return NextResponse.json(serializeChat(chat));
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const user = await requireUser();
    await requireOwnedChat(chatId, user.id);
    const input = UpdateChatRequestSchema.parse(await req.json());

    const chat = await prisma.chat.update({
      where: { id: chatId },
      data: input,
    });
    return NextResponse.json(serializeChat(chat));
  });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, chatId }, async () => {
    const user = await requireUser();
    await requireOwnedChat(chatId, user.id);

    // Soft delete — history (messages/runs) is kept for audit, just hidden
    // from list/read.
    await prisma.chat.update({ where: { id: chatId }, data: { deletedAt: new Date() } });
    return new NextResponse(null, { status: 204 });
  });
}
