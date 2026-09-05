import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { serializeMessage } from "@/lib/serialize";
import { runTurn } from "@/lib/agent/run-turn";
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
 * Send-turn: validate → persist the user's message → dispatch a run →
 * stream the assistant's reply back over the same response as it's
 * generated. The dispatch itself runs in-process for Day 1 (see
 * src/lib/agent/run-turn.ts) — everything about this contract (idempotency,
 * one-active-run-per-chat, the {chatId,messageId,runId} envelope) stays the
 * same once that call becomes a Trigger.dev task.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { chatId } = await params;
  const traceId = newTraceId();
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Unauthorized" } }, { status: 401 });
  }

  const chat = await requireOwnedChat(chatId, user.id).catch(() => null);
  if (!chat) {
    return NextResponse.json({ error: { code: "not_found", message: "Chat not found" } }, { status: 404 });
  }

  const parsed = SendTurnRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "Validation failed", issues: parsed.error.issues } },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Idempotent dispatch: a retried send for a key we've already dispatched
  // returns the same {chatId,messageId,runId} rather than creating a
  // duplicate run — this must survive network retries and double-clicks.
  const existingRun = await prisma.agentRun.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existingRun) {
    const existingMessage = await prisma.message.findFirst({
      where: { runId: existingRun.id, role: "USER" },
    });
    const body = SendTurnResponseSchema.parse({
      chatId,
      messageId: existingMessage?.id ?? existingRun.id,
      runId: existingRun.id,
    });
    return NextResponse.json(body, { status: 200 });
  }

  // One active run per chat, enforced here (and backstopped by a partial
  // unique index once one exists — see prisma/schema.prisma) before we ever
  // touch OpenRouter.
  const activeRun = await prisma.agentRun.findFirst({
    where: { chatId, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
  });
  if (activeRun) {
    return NextResponse.json(
      { error: { code: "run_in_progress", message: "This chat already has an active run" } },
      { status: 409 },
    );
  }

  const { userMessage, run } = await prisma.$transaction(async (tx) => {
    // Auto-title on the first message so the chat list isn't just "New
    // chat" repeated for every entry — checked inside the transaction so a
    // concurrent send-turn on the same brand-new chat can't race this.
    const isFirstMessage = (await tx.message.count({ where: { chatId } })) === 0;
    const title = isFirstMessage ? titleFromContent(input.content) : null;

    const userMessage = await tx.message.create({
      data: {
        chatId,
        role: "USER",
        status: "COMPLETE",
        content: input.content,
      },
    });
    const run = await tx.agentRun.create({
      data: { chatId, idempotencyKey: input.idempotencyKey, status: "QUEUED" },
    });
    // Bumps Chat.updatedAt too (Prisma's @updatedAt fires on any update()),
    // which is what keeps the sidebar's most-recent-first ordering honest —
    // creating a Message doesn't touch its parent Chat's timestamp on its own.
    await tx.chat.update({ where: { id: chatId }, data: title ? { title } : {} });
    return { userMessage, run };
  });

  const envelope = SendTurnResponseSchema.parse({ chatId, messageId: userMessage.id, runId: run.id });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("dispatched", envelope);
      try {
        await runTurn(run.id, (delta) => send("delta", { text: delta }));
        send("done", {});
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : "Agent turn failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Trace-Id": traceId,
    },
  });
}
