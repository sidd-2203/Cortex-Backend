import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { withApiError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { generateApiKey } from "@/lib/auth-api-key";
import { ListApiKeysResponseSchema, CreateApiKeyRequestSchema, CreateApiKeyResponseSchema } from "@/contracts/api-keys";
import type { ApiKey } from "../../../../prisma/generated/prisma/client";

function serialize(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

/**
 * Self-serve API key management, Clerk-authed same as every other
 * first-party route — this is a signed-in user managing their own
 * credentials for /api/v1, not a public-API caller (that's requireApiKey,
 * a different auth entirely). Revoked keys stay in the list rather than
 * disappearing — a security-relevant history is more useful visible than
 * hidden, same reasoning as Chat's own soft delete.
 */
export async function GET() {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();
    const keys = await prisma.apiKey.findMany({ where: { ownerId: user.id }, orderBy: { createdAt: "desc" } });
    return NextResponse.json(ListApiKeysResponseSchema.parse({ items: keys.map(serialize) }));
  });
}

/** Creates a new key for the signed-in user. The full secret is returned exactly once, in this response only. */
export async function POST(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const user = await requireUser();
    const input = CreateApiKeyRequestSchema.parse(await req.json().catch(() => null));

    const { key, keyPrefix, hashedKey } = generateApiKey();
    const record = await prisma.apiKey.create({
      data: { ownerId: user.id, name: input.name, keyPrefix, hashedKey },
    });

    const body = CreateApiKeyResponseSchema.parse({ ...serialize(record), key });
    return NextResponse.json(body, { status: 201 });
  });
}
