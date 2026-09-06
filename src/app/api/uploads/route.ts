import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { createAssembly } from "@/lib/transloadit/client";
import { CreateUploadRequestSchema, CreateUploadResponseSchema } from "@/contracts/uploads";

/**
 * Stage 1 of a direct-to-Transloadit upload: create an Assembly and an
 * Attachment row to track it, then hand the frontend everything it needs to
 * do the actual tus upload itself. The file's bytes never touch this route —
 * that's the point, since Vercel's function limits don't apply to a
 * browser-to-Transloadit connection.
 */
export async function POST(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();
    const input = CreateUploadRequestSchema.parse(await req.json().catch(() => null));

    const { assemblyId, assemblySslUrl, tusUrl } = await createAssembly({ ownerId: user.id });

    const attachment = await prisma.attachment.create({
      data: { ownerId: user.id, type: input.type, assemblyId, status: "UPLOADING" },
    });

    const body = CreateUploadResponseSchema.parse({
      attachmentId: attachment.id,
      tusEndpoint: tusUrl,
      assemblyUrl: assemblySslUrl,
    });
    return NextResponse.json(body, { status: 201 });
  });
}
