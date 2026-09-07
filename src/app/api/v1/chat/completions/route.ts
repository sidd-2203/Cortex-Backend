import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth-api-key";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError, ApiError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { dispatchTurn } from "@/lib/agent/dispatch-turn";
import { CreateCompletionRequestSchema, CreateCompletionResponseSchema } from "@/contracts/public-api";

/**
 * OpenAI-chat-completions-shaped entry point: POST {messages: [...]} with
 * no chatId starts a brand-new conversation, or pass an existing chatId to
 * continue one. Async by design (see docs/chat-completions.mdx) — the
 * response is a queued run, not a finished answer; poll
 * GET /api/v1/runs/:id or register a webhook to find out when it's done.
 * Only the *last* message's content is actually used as the new turn —
 * conversation history already lives server-side, keyed by chatId, so this
 * isn't a stateless full-history replay the way OpenAI's own endpoint is.
 */
export async function POST(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const { ownerId } = await requireApiKey(req);
    const input = CreateCompletionRequestSchema.parse(await req.json().catch(() => null));

    let chatId = input.chatId;
    if (chatId) {
      const chat = await prisma.chat.findFirst({ where: { id: chatId, ownerId, deletedAt: null } });
      if (!chat) throw new NotFoundError("Chat");
    } else {
      const chat = await prisma.chat.create({ data: { ownerId, title: "New chat" } });
      chatId = chat.id;
    }

    const lastMessage = input.messages[input.messages.length - 1];
    if (!lastMessage) throw new ApiError(400, "invalid_request", "messages must contain at least one entry");

    const dispatched = await dispatchTurn({
      chatId,
      ownerId,
      idempotencyKey: crypto.randomUUID(),
      content: [{ type: "text", text: lastMessage.content }],
    });

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: dispatched.runId } });

    const body = CreateCompletionResponseSchema.parse({
      id: dispatched.runId,
      object: "chat.completion.queued",
      chatId,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
    });
    return NextResponse.json(body, { status: 202 });
  });
}
