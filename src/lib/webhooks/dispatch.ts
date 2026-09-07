import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Prisma } from "../../../prisma/generated/prisma/client";

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

export type WebhookEvent = "agent.started" | "agent.completed" | "agent.failed" | "tool.completed";

const DELIVERY_TIMEOUT_MS = 5000;

/**
 * Fire-and-forget signed delivery — one POST attempt per registered
 * endpoint, no retry (see the webhook-reliability scoping decision). Every
 * attempt still gets a WebhookDelivery row either way, so a failure is
 * something the endpoint's owner can actually go look at rather than
 * silently vanishing into a log line only we can see.
 *
 * Deliberately not awaited by callers (run-turn.ts, execute-tool-call.ts)
 * — a webhook consumer being slow or down must never add latency to (or
 * fail) the agent turn that triggered it.
 */
export async function dispatchWebhookEvent(
  ownerId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { ownerId, active: true } });
  if (endpoints.length === 0) return;

  const envelope = { event, createdAt: new Date().toISOString(), data: payload };
  const body = JSON.stringify(envelope);

  await Promise.all(
    endpoints.map(async (endpoint) => {
      // Stripe-style signed-timestamp scheme: signing `${timestamp}.${body}`
      // rather than just `body` means a captured (signature, body) pair
      // can't be replayed indefinitely — a consumer that checks the
      // timestamp's own freshness gets real replay protection, not just
      // origin authentication.
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", endpoint.secret).update(`${timestamp}.${body}`).digest("hex");

      let statusCode: number | null = null;
      let error: string | null = null;
      try {
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cortex-Event": event,
            "X-Cortex-Signature": `t=${timestamp},v1=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        statusCode = res.status;
        if (!res.ok) error = `Endpoint responded with ${res.status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (error) {
        logger.warn("webhook delivery failed", { ownerId, event, endpointId: endpoint.id, statusCode, error });
      }

      await prisma.webhookDelivery
        .create({ data: { endpointId: endpoint.id, event, payload: asJson(envelope), statusCode, error } })
        .catch(() => {}); // the delivery itself already happened (or didn't) — a logging failure shouldn't surface as this call's own error
    }),
  );
}
