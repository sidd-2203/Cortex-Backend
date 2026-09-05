import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { serializeChat } from "@/lib/serialize";
import { encodeCursor, decodeCursor } from "@/lib/cursor";
import {
  CreateChatRequestSchema,
  CursorPageRequestSchema,
  cursorPageResponseSchema,
  ChatSummarySchema,
} from "@/contracts/chat";

export async function GET(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const { cursor, limit } = CursorPageRequestSchema.parse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const search = searchParams.get("search")?.trim();
    const pinnedOnly = searchParams.get("pinned") === "true";

    const where = {
      ownerId: user.id,
      deletedAt: null,
      ...(pinnedOnly ? { pinned: true } : {}),
      ...(search ? { title: { contains: search, mode: "insensitive" as const } } : {}),
    };

    const decoded = cursor ? decodeCursor(cursor) : null;
    const chats = await prisma.chat.findMany({
      where: decoded
        ? {
            ...where,
            OR: [
              { updatedAt: { lt: decoded.timestamp } },
              { updatedAt: decoded.timestamp, id: { lt: decoded.id } },
            ],
          }
        : where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = chats.length > limit;
    const page = hasMore ? chats.slice(0, limit) : chats;
    const nextCursor =
      hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.updatedAt, page[page.length - 1]!.id) : null;

    const body = cursorPageResponseSchema(ChatSummarySchema).parse({
      items: page.map(serializeChat),
      nextCursor,
    });
    return NextResponse.json(body);
  });
}

export async function POST(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();
    const input = CreateChatRequestSchema.parse(await req.json().catch(() => ({})));

    const chat = await prisma.chat.create({
      data: { ownerId: user.id, title: input.title ?? "New chat" },
    });

    return NextResponse.json(serializeChat(chat), { status: 201 });
  });
}
