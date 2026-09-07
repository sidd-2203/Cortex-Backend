import { task, streams } from "@trigger.dev/sdk";
import { runTurn } from "@/lib/agent/run-turn";
import { PushQueue } from "@/lib/agent/push-queue";

/**
 * The durable version of the agent loop. Day 1 ran `runTurn()` directly
 * inside the route handler, holding the HTTP connection open for the whole
 * completion — fine locally, but Vercel serverless functions cap out at a
 * few seconds, well short of what a full LLM response can take. Now the
 * route handler just dispatches this task and returns immediately; the
 * frontend subscribes to two Realtime streams directly instead of waiting
 * on our backend to relay anything: `delta` for text tokens, `tool` for
 * tool-call start/finish events (see run-turn.ts's onToolEvent) — without
 * the second stream, a tool call (which can run for minutes — see
 * magica/client.ts) was invisible until the entire turn finished.
 */
export const agentTurnTask = task({
  id: "agent-turn",
  // Raised alongside magica/client.ts's own poll timeout (also just raised,
  // to 300s) — a turn that calls a slow image/video tool needs real room
  // beyond that one call: the LLM round trips before and after it, and a
  // turn can make more than one such call before finishing.
  maxDuration: 900,
  run: async (payload: { agentRunId: string }, { ctx }) => {
    const deltaQueue = new PushQueue<string>();
    const toolQueue = new PushQueue<string>();
    const [delta, tool] = await Promise.all([
      streams.pipe("delta", deltaQueue),
      streams.pipe("tool", toolQueue),
    ]);

    try {
      await runTurn(
        payload.agentRunId,
        (chunk) => deltaQueue.push(chunk),
        // Serialized to JSON — the stream itself only carries strings, same
        // as the delta stream; the frontend parses each part back out.
        (event) => toolQueue.push(JSON.stringify(event)),
        { isFinalAttempt: ctx.attempt.number >= (ctx.run.maxAttempts ?? 1) },
      );
    } finally {
      deltaQueue.close();
      toolQueue.close();
      await Promise.all([delta.waitUntilComplete(), tool.waitUntilComplete()]);
    }
  },
});
