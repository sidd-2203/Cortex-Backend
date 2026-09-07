import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

/**
 * Revokes a key — soft, via revokedAt, not a hard delete, so it stays
 * visible in the list as a record of what happened (see route.ts). Once
 * revoked, requireApiKey (the /api/v1 auth check) rejects it immediately;
 * this never touches anything already in flight on that key.
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();

    const key = await prisma.apiKey.findFirst({ where: { id, ownerId: user.id } });
    if (!key) throw new NotFoundError("API key");

    if (!key.revokedAt) {
      await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    }
    return new NextResponse(null, { status: 204 });
  });
}
