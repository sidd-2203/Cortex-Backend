// OpenRouter Free Router client. This is one of the three integrations that
// must be real end-to-end (no paid fallback, ever) — model is hardcoded to
// "openrouter/free", which is OpenRouter's router that picks a free
// underlying model per-request (filtered for the capabilities the request
// needs, e.g. tool calling). The underlying model that actually served the
// request comes back in the response body's `model` field — that value is
// what the "Model Discovery" tool records, never the router alias itself.

const OPENROUTER_MODEL = "openrouter/free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on a "tool" role message — which call this is the result of. */
  tool_call_id?: string;
  /** Set on an "assistant" message that requested tool calls. */
  tool_calls?: OpenRouterToolCall[];
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

/**
 * Coarse categories the UI can actually say something useful about — a raw
 * status code or provider string isn't something a user can act on, but
 * "you've hit the free tier's rate limit, try again shortly" is.
 */
export type OpenRouterErrorCode =
  | "missing_api_key"
  | "rate_limited"
  | "timeout"
  | "upstream_error"
  | "unknown";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public code: OpenRouterErrorCode = "unknown",
    public status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** The whole streamed completion, not just time-to-first-byte — free models can be slow. */
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1500;

function isRetryable(status: number): boolean {
  // 429 is usually the per-minute cap (clears in seconds); the per-day cap
  // won't clear on retry, but the two aren't distinguishable from the
  // response alone, so a small bounded retry is the right trade.
  return status === 429 || (status >= 500 && status < 600);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    throw new OpenRouterError("OPENROUTER_API_KEY is not set", "missing_api_key");
  }

  // Only the connection and the response status are retried — once the
  // stream body starts being consumed, tokens have already been forwarded
  // to the UI via onTextDelta, so retrying from there would duplicate text.
  let res: Response | null = null;
  let lastError: OpenRouterError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

    try {
      const response = await fetch(OPENROUTER_URL, {
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
        signal,
      });

      if (response.ok && response.body) {
        res = response;
        break;
      }

      const body = await response.text().catch(() => "");
      lastError = new OpenRouterError(
        response.status === 429
          ? "Rate limited by OpenRouter's free tier — try again shortly."
          : `OpenRouter request failed (${response.status}): ${body}`,
        response.status === 429 ? "rate_limited" : "upstream_error",
        response.status,
      );
      if (!isRetryable(response.status) || attempt === MAX_ATTEMPTS) throw lastError;
    } catch (err) {
      if (err instanceof OpenRouterError) {
        if (attempt === MAX_ATTEMPTS) throw err;
        lastError = err;
      } else if (err instanceof Error && err.name === "TimeoutError") {
        lastError = new OpenRouterError(
          `OpenRouter didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s.`,
          "timeout",
        );
        if (attempt === MAX_ATTEMPTS) throw lastError;
      } else if (err instanceof Error && err.name === "AbortError") {
        throw new OpenRouterError("Request cancelled", "unknown"); // caller-initiated: don't retry
      } else {
        lastError = new OpenRouterError(
          err instanceof Error ? err.message : "Network error reaching OpenRouter",
          "upstream_error",
        );
        if (attempt === MAX_ATTEMPTS) throw lastError;
      }
    }

    await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 500);
  }

  if (!res?.body) {
    throw lastError ?? new OpenRouterError("OpenRouter request failed", "unknown");
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
