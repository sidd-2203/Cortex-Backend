import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { encodeCursor, decodeCursor } from "@/lib/cursor";
import { CreditLedgerEntrySchema } from "@/contracts/credits";
import { CursorPageRequestSchema, cursorPageResponseSchema } from "@/contracts/chat";

export async function GET(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();
    const { searchParams } = new URL(req.url);
    const { cursor, limit } = CursorPageRequestSchema.parse({
      cursor: searchParams.get("cursor"),
      limit: searchParams.get("limit") ?? undefined,
    });
    const decoded = cursor ? decodeCursor(cursor) : null;

    const entries = await prisma.creditLedger.findMany({
      where: {
        ownerId: user.id,
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

    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const nextCursor =
      hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!.createdAt, page[page.length - 1]!.id) : null;

    const body = cursorPageResponseSchema(CreditLedgerEntrySchema).parse({
      items: page.map((e) => ({
        id: e.id,
        delta: e.delta,
        reason: e.reason,
        relatedInvocationId: e.relatedInvocationId,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor,
    });
    return NextResponse.json(body);
  });
}
