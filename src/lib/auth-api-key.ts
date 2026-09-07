import { createHash, randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { prisma } from "./db";
import { UnauthorizedError } from "./auth";

const KEY_PREFIX = "ctx_live_";

/** SHA-256, hex — plain hashing (not bcrypt/argon2) is correct here since a full API key is already high-entropy random bytes, not a low-entropy human password. */
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Generates a new key + its storable fields. The full key is returned once, by the caller (scripts/mint-api-key.ts) — nothing here ever persists it. */
export function generateApiKey(): { key: string; keyPrefix: string; hashedKey: string } {
  const key = `${KEY_PREFIX}${randomBytes(24).toString("hex")}`;
  return { key, keyPrefix: key.slice(0, 16), hashedKey: hashKey(key) };
}

/**
 * Public-API equivalent of requireUser() — resolves the calling developer
 * from an `Authorization: Bearer ctx_live_...` header instead of a Clerk
 * session, since a server-to-server caller has no browser session to hold
 * one. Every /api/v1 route goes through this rather than requireUser().
 *
 * lastUsedAt is updated best-effort (not awaited) — it's an operational
 * convenience for the key's owner, not something worth adding request
 * latency for.
 */
export async function requireApiKey(req: NextRequest): Promise<{ ownerId: string; apiKeyId: string }> {
  const header = req.headers.get("authorization");
  const key = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!key) throw new UnauthorizedError();

  const record = await prisma.apiKey.findUnique({ where: { hashedKey: hashKey(key) } });
  if (!record || record.revokedAt) throw new UnauthorizedError();

  void prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  return { ownerId: record.ownerId, apiKeyId: record.id };
}
