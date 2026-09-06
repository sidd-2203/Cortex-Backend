import { z } from "zod";

// Ordered content blocks that make up a Message.content array. This is the
// single shape both persistence (JSONB) and realtime streaming speak — the
// frontend never redefines this, it imports the inferred types below.

export const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  text: z.string(),
});

export const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(), // stable id, referenced by the matching tool_result block
  toolName: z.string(),
  input: z.unknown(),
});

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  output: z.unknown(),
  isError: z.boolean().default(false),
});

export const CitationBlockSchema = z.object({
  type: z.literal("citation"),
  text: z.string(),
  source: z.string(),
});

export const AttachmentTypeSchema = z.enum(["IMAGE", "VIDEO", "AUDIO", "DOCUMENT", "OTHER"]);

// A user-uploaded file (via Transloadit), attached to the message that sent
// it. `url` is the stable, permanent URL once the upload has finished
// processing — attachmentIds only resolve into one of these once their
// Attachment row is READY (see the send-turn route), so this block is never
// persisted mid-upload.
export const AttachmentBlockSchema = z.object({
  type: z.literal("attachment"),
  attachmentId: z.string(),
  attachmentType: AttachmentTypeSchema,
  url: z.string(),
  filename: z.string().nullable(),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  CitationBlockSchema,
  AttachmentBlockSchema,
]);

export const MessageContentSchema = z.array(ContentBlockSchema);

export type TextBlock = z.infer<typeof TextBlockSchema>;
export type ThinkingBlock = z.infer<typeof ThinkingBlockSchema>;
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;
export type CitationBlock = z.infer<typeof CitationBlockSchema>;
export type AttachmentType = z.infer<typeof AttachmentTypeSchema>;
export type AttachmentBlock = z.infer<typeof AttachmentBlockSchema>;
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type MessageContent = z.infer<typeof MessageContentSchema>;
