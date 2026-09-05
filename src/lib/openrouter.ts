// OpenRouter Free Router client. This is one of the three integrations that
// must be real end-to-end (no paid fallback, ever) — model is hardcoded to
// "openrouter/free", which is OpenRouter's router that picks a free
// underlying model per-request (filtered for the capabilities the request
// needs, e.g. tool calling). The underlying model that actually served the
// request comes back in the response body's `model` field — that value is
// what the "Model Discovery" tool records, never the router alias itself.

const OPENROUTER_MODEL = "openrouter/free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface OpenRouterToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatStreamResult {
  /** Actual underlying model that served the request, per OpenRouter. */
  model: string | null;
  fullText: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/**
 * Streams a chat completion from OpenRouter Free. Calls `onTextDelta` for
 * each token chunk as it arrives (for realtime forwarding) and resolves with
 * the accumulated result once the stream ends.
 */
export async function streamChatCompletion(
  messages: OpenRouterMessage[],
  opts: {
    tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }>;
    onTextDelta?: (delta: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<ChatStreamResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not set");
  }

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Optional but recommended by OpenRouter for attribution/rankings.
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://cortex.app",
      "X-Title": "Cortex",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      stream: true,
      ...(opts.tools ? { tools: opts.tools } : {}),
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new OpenRouterError(`OpenRouter request failed (${res.status}): ${body}`, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let model: string | null = null;
  let finishReason: string | null = null;
  const toolCallsByIndex = new Map<number, { id: string; name: string; arguments: string }>();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;

      let json: {
        model?: string;
        choices?: Array<{
          delta?: { content?: string; tool_calls?: OpenRouterToolCallDelta[] };
          finish_reason?: string | null;
        }>;
      };
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // ignore malformed/partial SSE chunks rather than aborting the whole turn
      }

      if (json.model) model = json.model;

      const choice = json.choices?.[0];
      if (choice?.delta?.content) {
        fullText += choice.delta.content;
        opts.onTextDelta?.(choice.delta.content);
      }
      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const existing = toolCallsByIndex.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCallsByIndex.set(tc.index, existing);
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }

  return {
    model,
    fullText,
    toolCalls: [...toolCallsByIndex.values()],
    finishReason,
  };
}
