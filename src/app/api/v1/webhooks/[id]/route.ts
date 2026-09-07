import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth-api-key";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";

type Params = { params: Promise<{ id: string }> };

/** Removes a webhook endpoint — no more deliveries are attempted to it after this. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const { ownerId } = await requireApiKey(req);

    const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id, ownerId } });
    if (!endpoint) throw new NotFoundError("Webhook endpoint");

    await prisma.webhookEndpoint.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  });
}
