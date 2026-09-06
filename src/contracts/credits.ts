import { z } from "zod";

export const CreditReasonSchema = z.enum(["GRANT", "TOOL_CHARGE", "REFUND", "ADJUSTMENT"]);

export const CreditBalanceResponseSchema = z.object({
  balance: z.number().int(),
});
export type CreditBalanceResponse = z.infer<typeof CreditBalanceResponseSchema>;

export const CreditLedgerEntrySchema = z.object({
  id: z.string(),
  delta: z.number().int(),
  reason: CreditReasonSchema,
  relatedInvocationId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntrySchema>;
