import { task, streams } from "@trigger.dev/sdk";
import { runTurn } from "@/lib/agent/run-turn";
import { PushQueue } from "@/lib/agent/push-queue";

/**
 * The durable version of the agent loop. Day 1 ran `runTurn()` directly
 * inside the route handler, holding the HTTP connection open for the whole
 * completion — fine locally, but Vercel serverless functions cap out at a
 * few seconds, well short of what a full LLM response can take. Now the
 * route handler just dispatches this task and returns immediately; the
 * frontend subscribes to the `delta` stream directly via Trigger.dev
 * Realtime instead of waiting on our backend to relay it.
 */
export const agentTurnTask = task({
  id: "agent-turn",
  maxDuration: 300,
  run: async (payload: { agentRunId: string }) => {
    const queue = new PushQueue<string>();
    const { waitUntilComplete } = await streams.pipe("delta", queue);

    try {
      await runTurn(payload.agentRunId, (delta) => queue.push(delta));
    } finally {
      queue.close();
      await waitUntilComplete();
    }
  },
});
