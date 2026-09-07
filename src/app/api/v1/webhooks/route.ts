import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth-api-key";
import { prisma } from "@/lib/db";
import { withApiError } from "@/lib/api-error";
import { newTraceId } from "@/lib/logger";
import { CreateWebhookRequestSchema, CreateWebhookResponseSchema, ListWebhooksResponseSchema } from "@/contracts/public-api";

function serialize(endpoint: { id: string; url: string; active: boolean; createdAt: Date }) {
  return { id: endpoint.id, url: endpoint.url, active: endpoint.active, createdAt: endpoint.createdAt.toISOString() };
}

/** List the caller's registered webhook endpoints. Secrets are never re-shown after creation. */
export async function GET(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const { ownerId } = await requireApiKey(req);
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" } });
    return NextResponse.json(ListWebhooksResponseSchema.parse({ items: endpoints.map(serialize) }));
  });
}

/**
 * Registers a URL to receive signed lifecycle events (agent.started/
 * completed/failed, tool.completed — see src/lib/webhooks/dispatch.ts).
 * The signing secret is generated here and returned exactly once; verify
 * incoming deliveries against it using the X-Cortex-Signature header
 * (see docs/webhooks.mdx).
 */
export async function POST(req: NextRequest) {
  const traceId = newTraceId();
  return withApiError({ traceId }, async () => {
    const { ownerId } = await requireApiKey(req);
    const input = CreateWebhookRequestSchema.parse(await req.json().catch(() => null));

    const secret = `whsec_${randomBytes(24).toString("hex")}`;
    const endpoint = await prisma.webhookEndpoint.create({
      data: { ownerId, url: input.url, secret },
    });

    const body = CreateWebhookResponseSchema.parse({ ...serialize(endpoint), secret });
    return NextResponse.json(body, { status: 201 });
  });
}
