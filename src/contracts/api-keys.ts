import { z } from "zod";

// First-party (Clerk-authed) API key self-management — distinct from the
// public /api/v1 surface these keys unlock. A user manages their own keys
// through here; the keys themselves authenticate to /api/v1.

export const ApiKeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKeySummary = z.infer<typeof ApiKeySummarySchema>;

export const ListApiKeysResponseSchema = z.object({
  items: z.array(ApiKeySummarySchema),
});
export type ListApiKeysResponse = z.infer<typeof ListApiKeysResponseSchema>;

export const CreateApiKeyRequestSchema = z.object({
  name: z.string().min(1).max(100),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

/** `key` is the full secret — present only in this one response, never again after it. */
export const CreateApiKeyResponseSchema = ApiKeySummarySchema.extend({
  key: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponseSchema>;
