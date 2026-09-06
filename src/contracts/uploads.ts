import { z } from "zod";
import { AttachmentTypeSchema } from "./content-blocks";

export const CreateUploadRequestSchema = z.object({
  type: AttachmentTypeSchema,
  filename: z.string().min(1).max(255),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

// Everything the frontend's tus client needs to upload directly to
// Transloadit — the file's bytes never pass through our backend.
export const CreateUploadResponseSchema = z.object({
  attachmentId: z.string(),
  tusEndpoint: z.string(),
  assemblyUrl: z.string(),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

export const AttachmentStatusSchema = z.enum(["UPLOADING", "READY", "FAILED"]);

export const AttachmentSchema = z.object({
  id: z.string(),
  type: AttachmentTypeSchema,
  status: AttachmentStatusSchema,
  url: z.string().nullable(),
  error: z.string().nullable(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;
