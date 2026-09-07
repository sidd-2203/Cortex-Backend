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

// A run subscription is everything the frontend needs to subscribe directly
// to Trigger.dev Realtime for a run's output — it talks to Trigger.dev's API
// for the actual token stream, not through our backend, which is what keeps
// our route handlers fast (dispatch and return, never holding the
// connection open for the full LLM completion).
export const RunSubscriptionSchema = z.object({
  runId: z.string(),
  triggerRunId: z.string(),
  publicAccessToken: z.string(),
});
export type RunSubscription = z.infer<typeof RunSubscriptionSchema>;

export const SendTurnResponseSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
}).merge(RunSubscriptionSchema);
export type SendTurnResponse = z.infer<typeof SendTurnResponseSchema>;

// --- Active run resume (GET /api/chats/:chatId/active-run) --------------
// Reload recovery: on load, the frontend asks "is there an in-flight run on
// this chat?" and if so gets a fresh subscription to resume it — the
// original trigger-time token isn't persisted (short-lived by design), so
// resuming always mints a new one scoped to the existing run.

export const ActiveRunResponseSchema = RunSubscriptionSchema.nullable();
export type ActiveRunResponse = z.infer<typeof ActiveRunResponseSchema>;

// --- Run cancellation (POST /api/runs/:runId/cancel) ---------------------
// Cooperative, not a kill: this only flips the run to STOPPING. The task
// itself notices between steps and winds down (see run-turn.ts), which is
// what keeps a half-finished Magica job from being orphaned mid-flight.

export const RunStatusSchema = z.enum([
  "QUEUED",
  "THINKING",
  "WORKING",
  "WAITING",
  "STOPPING",
  "COMPLETE",
  "FAILED",
  "CANCELLED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const CancelRunResponseSchema = z.object({
  // The run's status after the request. STOPPING on success; an already
  // terminal status is returned as-is rather than erroring, so a
  // double-click on Stop is harmless.
  status: RunStatusSchema,
});
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

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
