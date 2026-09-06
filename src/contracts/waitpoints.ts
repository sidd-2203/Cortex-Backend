import { z } from "zod";

export const ResolveWaitpointRequestSchema = z.object({
  approved: z.boolean(),
  comment: z.string().max(500).optional(),
});
export type ResolveWaitpointRequest = z.infer<typeof ResolveWaitpointRequestSchema>;

export const WaitpointStatusSchema = z.enum(["PENDING", "RESOLVED", "EXPIRED"]);

export const ResolveWaitpointResponseSchema = z.object({
  status: WaitpointStatusSchema,
});
export type ResolveWaitpointResponse = z.infer<typeof ResolveWaitpointResponseSchema>;
