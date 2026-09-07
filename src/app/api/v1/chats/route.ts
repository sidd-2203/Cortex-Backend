import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth-api-key";
import { prisma } from "@/lib/db";
import { withApiError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { serializeChat } from "@/lib/serialize";
import { encodeCursor, decodeCursor } from "@/lib/cursor";
import { CursorPageRequestSchema, cursorPageResponseSchema, ChatSummarySchema } from "@/contracts/chat";

/** Conversation reads: list the caller's chats, newest-first, cursor-paginated same as the first-party API. */
export async function GET(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const { ownerId } = await requireApiKey(req);

    const { searchParams } = new URL(req.url);
    const { cursor, limit } = CursorPageRequestSchema.parse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const decoded = cursor ? decodeCursor(cursor) : null;
    const where = { ownerId, deletedAt: null };

    const chats = await prisma.chat.findMany({
      where: decoded
        ? { ...where, OR: [{ updatedAt: { lt: decoded.timestamp } }, { updatedAt: decoded.timestamp, id: { lt: decoded.id } }] }
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
