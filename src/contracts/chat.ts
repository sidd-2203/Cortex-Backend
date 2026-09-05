import { z } from "zod";
import { MessageContentSchema } from "./content-blocks";

export const MessageRoleSchema = z.enum(["USER", "ASSISTANT", "SYSTEM", "TOOL"]);
export const MessageStatusSchema = z.enum([
  "QUEUED",
  "STREAMING",
  "COMPLETE",
  "FAILED",
  "CANCELLED",
]);

export const MessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  runId: z.string().nullable(),
  role: MessageRoleSchema,
  status: MessageStatusSchema,
  content: MessageContentSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ChatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ChatSummary = z.infer<typeof ChatSummarySchema>;

// --- Cursor pagination -------------------------------------------------

export const CursorPageRequestSchema = z.object({
  cursor: z.string().nullable().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type CursorPageRequest = z.infer<typeof CursorPageRequestSchema>;

export function cursorPageResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

// --- Send-turn (POST /api/chats/:chatId/messages) ----------------------

export const SendTurnRequestSchema = z.object({
  // Client-generated key: retries of the same user action must not dispatch
  // a second run. One key maps to exactly one AgentRun.
  idempotencyKey: z.string().min(1),
  content: z
    .array(z.object({ type: z.literal("text"), text: z.string().min(1) }))
    .min(1),
  attachmentIds: z.array(z.string()).default([]),
});
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>;

export const SendTurnResponseSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  runId: z.string(),
});
export type SendTurnResponse = z.infer<typeof SendTurnResponseSchema>;

// --- Chat management -----------------------------------------------------

export const CreateChatRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});
export type CreateChatRequest = z.infer<typeof CreateChatRequestSchema>;

export const UpdateChatRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
});
export type UpdateChatRequest = z.infer<typeof UpdateChatRequestSchema>;
