import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError, NotFoundError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { getAssemblyStatus } from "@/lib/transloadit/client";
import { AttachmentSchema } from "@/contracts/uploads";
import type { Attachment } from "../../../../../prisma/generated/prisma/client";

type Params = { params: Promise<{ attachmentId: string }> };

function serialize(a: Attachment) {
  return AttachmentSchema.parse({ id: a.id, type: a.type, status: a.status, url: a.url, error: a.error });
}

/**
 * Stage 2's status check — mirrors the run/poll shape already used for
 * Magica: the frontend calls this every couple of seconds after its tus
 * upload finishes, until status flips to READY or FAILED. Polling
 * Transloadit itself only happens while our own row still says UPLOADING,
 * so a finished attachment never re-hits their API.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { attachmentId } = await params;
  const traceId = newTraceId();
  return withApiError({ traceId, attachmentId }, async () => {
    const user = await requireUser();
    const attachment = await prisma.attachment.findFirst({ where: { id: attachmentId, ownerId: user.id } });
    if (!attachment) throw new NotFoundError("Attachment");

    if (attachment.status !== "UPLOADING" || !attachment.assemblyId) {
      return NextResponse.json(serialize(attachment));
    }

    const status = await getAssemblyStatus(attachment.assemblyId);

    if (status.isComplete) {
      const updated = await prisma.attachment.update({
        where: { id: attachment.id },
        data: status.resultFile
          ? { status: "READY", url: status.resultFile.sslUrl }
          : { status: "FAILED", error: "Assembly completed without a usable output file" },
      });
      return NextResponse.json(serialize(updated));
    }

    if (status.isFailed) {
      const updated = await prisma.attachment.update({
        where: { id: attachment.id },
        data: { status: "FAILED", error: status.error },
      });
      return NextResponse.json(serialize(updated));
    }

    // Still uploading/processing — report current (still UPLOADING) state.
    return NextResponse.json(serialize(attachment));
  });
}
