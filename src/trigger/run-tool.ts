import { task } from "@trigger.dev/sdk";
import { runDirectToolCall } from "@/lib/agent/run-direct-tool";

/**
 * The durable version of a direct tool call — the public API's
 * "Magica tool execution" endpoint (POST /api/v1/chats/:chatId/tools)
 * dispatches this and returns immediately, same reasoning as agent-turn.ts:
 * a slow Magica generation shouldn't hold a Vercel serverless function's
 * connection open. No Realtime stream here (unlike agent-turn.ts) — a
 * single tool call has nothing incremental to stream; the caller polls
 * GET /api/v1/runs/:runId or waits for the tool.completed webhook.
 */
export const runToolTask = task({
  id: "run-tool",
  maxDuration: 300,
  run: async (payload: { agentRunId: string; toolName: string; input: unknown }) => {
    await runDirectToolCall({ runId: payload.agentRunId, toolName: payload.toolName, input: payload.input });
  },
});
