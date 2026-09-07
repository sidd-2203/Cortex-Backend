import { z } from "zod";
import { ToolUseBlockSchema, ToolResultBlockSchema } from "./content-blocks";

// The wire shape pushed onto Trigger.dev's "tool" Realtime stream (see
// agent-turn.ts) — deliberately separate from content-blocks.ts, which is
// what gets persisted. This is transport-only: nothing here is ever written
// to a Message row. Reuses ToolUseBlock/ToolResultBlock rather than
// inventing a parallel shape, so the frontend renders a live tool call with
// the exact same component it renders a persisted one with.
export const ToolStreamEventSchema = z.discriminatedUnion("kind", [
  // Emitted the moment the model requests a tool call, before it's even
  // been validated — `block.input` is undefined at this point.
  z.object({ kind: z.literal("started"), block: ToolUseBlockSchema }),
  // Emitted once that specific call settles (success or failure) — `block`
  // now carries the validated input, `result` the outcome.
  z.object({ kind: z.literal("finished"), block: ToolUseBlockSchema, result: ToolResultBlockSchema }),
  // The run has parked on an approval waitpoint and is going nowhere until
  // someone answers. `token` is what the frontend POSTs back to
  // /api/waitpoints/[token]/resolve. Carries everything the approval card
  // needs to describe the pending call without a second round trip.
  z.object({
    kind: z.literal("approval_required"),
    token: z.string(),
    toolUseId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    cost: z.number(),
    expiresAt: z.string(),
  }),
  // The same waitpoint stopped being pending — answered here, answered from
  // another tab, denied by a cancellation, or expired. The frontend uses
  // this to retire the card rather than guessing from its own optimism.
  z.object({
    kind: z.literal("approval_resolved"),
    token: z.string(),
    approved: z.boolean(),
  }),
]);
export type ToolStreamEvent = z.infer<typeof ToolStreamEventSchema>;
