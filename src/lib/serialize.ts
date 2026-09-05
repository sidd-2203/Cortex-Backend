import type { Chat, Message as PrismaMessage } from "../../prisma/generated/prisma/client";
import type { ChatSummary, Message } from "../contracts/chat";
import { MessageContentSchema } from "../contracts/content-blocks";

// Prisma returns Date objects and untyped JSONB; every response crosses the
// Zod contract boundary here so a malformed row can never leak an invalid
// shape to the client — it fails loudly server-side instead.

export function serializeChat(chat: Chat): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    pinned: chat.pinned,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

export function serializeMessage(message: PrismaMessage): Message {
  return {
    id: message.id,
    chatId: message.chatId,
    runId: message.runId,
    role: message.role,
    status: message.status,
    content: MessageContentSchema.parse(message.content),
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
  };
}
