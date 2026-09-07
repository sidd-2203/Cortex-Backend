import { z } from "zod";
import { RunStatusSchema, MessageSchema } from "./chat";

// Contracts for the versioned public REST API (/api/v1) — kept separate
// from chat.ts's first-party shapes even where they overlap, since the
// public surface is a promise to external callers and shouldn't silently
// change just because the frontend's own internal shape does.

// --- Chat completions (POST /api/v1/chat/completions) ---------------------
// Shaped like OpenAI's chat-completions request (messages: [{role, content}])
// so an existing OpenAI-compatible client needs minimal changes to point at
// Cortex — but this is async, not a stateless multi-turn replay: only the
// last message's content becomes the new turn (conversation state already
// lives server-side, keyed by chatId), and the response is a queued run,
// not a finished completion. See docs/chat-completions.mdx.

export const CompletionMessageSchema = z.object({
  role: z.literal("user"),
  content: z.string().min(1),
});

export const CreateCompletionRequestSchema = z.object({
  /** Omit to start a new conversation. */
  chatId: z.string().optional(),
  messages: z.array(CompletionMessageSchema).min(1),
});
export type CreateCompletionRequest = z.infer<typeof CreateCompletionRequestSchema>;

export const CreateCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.queued"),
  chatId: z.string(),
  status: RunStatusSchema,
  createdAt: z.string(),
});
export type CreateCompletionResponse = z.infer<typeof CreateCompletionResponseSchema>;

// --- Public message submission (POST /api/v1/chats/:chatId/messages) -----

export const CreateMessageRequestSchema = z.object({
  content: z.string().min(1),
  attachmentIds: z.array(z.string()).default([]),
});
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;

export const CreateMessageResponseSchema = z.object({
  id: z.string(),
  runId: z.string(),
  chatId: z.string(),
  status: RunStatusSchema,
  createdAt: z.string(),
});
export type CreateMessageResponse = z.infer<typeof CreateMessageResponseSchema>;

// --- Direct tool execution (POST /api/v1/chats/:chatId/tools) ------------
// Bypasses the LLM loop entirely — a specific tool, called with specific
// input, by an authenticated developer. No approval gate: calling this
// endpoint at all *is* the approval (see run-direct-tool.ts).

export const RunToolRequestSchema = z.object({
  toolName: z.string().min(1),
  input: z.unknown(),
});
export type RunToolRequest = z.infer<typeof RunToolRequestSchema>;

export const RunToolResponseSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: RunStatusSchema,
  createdAt: z.string(),
});
export type RunToolResponse = z.infer<typeof RunToolResponseSchema>;

// --- Run status (GET /api/v1/runs/:runId) ---------------------------------

export const ToolInvocationStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);

export const ToolInvocationSummarySchema = z.object({
  id: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  status: ToolInvocationStatusSchema,
  cost: z.number(),
  durationMs: z.number().nullable(),
});
export type ToolInvocationSummary = z.infer<typeof ToolInvocationSummarySchema>;

export const RunStatusResponseSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: RunStatusSchema,
  model: z.string().nullable(),
  error: z.unknown().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** The assistant's message once it exists — null for a still-running turn, or a direct tool call (which has no message at all, only `tools`). */
  message: MessageSchema.nullable(),
  tools: z.array(ToolInvocationSummarySchema),
});
export type RunStatusResponse = z.infer<typeof RunStatusResponseSchema>;

// --- Webhooks (POST/GET /api/v1/webhooks, DELETE /api/v1/webhooks/:id) ---

export const CreateWebhookRequestSchema = z.object({
  url: z.string().url(),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

export const WebhookEndpointSchema = z.object({
  id: z.string(),
  url: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type WebhookEndpointSummary = z.infer<typeof WebhookEndpointSchema>;

/** Only returned once, at creation — the secret is never retrievable again after this (see prisma/schema.prisma's WebhookEndpoint model). */
export const CreateWebhookResponseSchema = WebhookEndpointSchema.extend({
  secret: z.string(),
});
export type CreateWebhookResponse = z.infer<typeof CreateWebhookResponseSchema>;

export const ListWebhooksResponseSchema = z.object({
  items: z.array(WebhookEndpointSchema),
});
