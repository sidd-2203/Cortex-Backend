import { z } from "zod";

// The one shape every tool in the system has: a Zod input schema, a Zod
// output schema, and an execute function in between. The agent loop never
// touches chat state directly from inside a tool — it calls execute(),
// gets back a validated, typed result, and the loop itself decides what to
// persist. This is what "tools don't mutate chat state directly" means in
// practice: a tool can't reach into Prisma and write a Message row itself.
export interface ToolExecutionContext {
  runId: string;
  chatId: string;
  ownerId: string;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  /** Credits charged per call. Omitted/0 for free tools (e.g. the skills tools). */
  cost?: number;
  /**
   * Gates the call behind a human approval waitpoint before execute() ever
   * runs — for anything a model shouldn't be able to trigger unilaterally
   * (a real charge, a destructive action). Rejected or timed-out approval
   * short-circuits to a failed tool_result; execute() is never called.
   */
  requiresApproval?: boolean;
  /** How long to wait for a decision before treating it as expired. Default 5 minutes. */
  approvalTimeoutSeconds?: number;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}

/**
 * Type-safe constructor — infers TInput/TOutput from the schemas instead of
 * making the caller spell them out. Returns `def` as-is: annotating the
 * return type as `ToolDefinition<In, Out>` here trips up on function
 * parameter contravariance (the same reason the registry itself stores
 * `ToolDefinition<any, any>` — a heterogeneous collection of differently
 * typed tools can't be variance-safe at the collection's type, only at each
 * tool's own definition site, which is what callers of defineTool get).
 */
export function defineTool<TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(def: {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  execute: (input: z.infer<TInputSchema>, ctx: ToolExecutionContext) => Promise<z.infer<TOutputSchema>>;
}) {
  return def;
}

// --- load_skill -----------------------------------------------------------

export const LoadSkillInputSchema = z.object({
  name: z.string().describe("The skill's name, as listed in the available-skills summary."),
});

export const LoadSkillOutputSchema = z.object({
  name: z.string(),
  content: z.string().describe("The skill's full guidance, in markdown."),
});

// --- read_skill_asset -------------------------------------------------------

export const ReadSkillAssetInputSchema = z.object({
  skillName: z.string().describe("The skill this asset belongs to."),
  assetPath: z
    .string()
    .describe("Path to the asset, relative to that skill's assets/ folder, e.g. \"formulas.md\"."),
});

export const ReadSkillAssetOutputSchema = z.object({
  content: z.string(),
});
