// Magica client — the generic "run a node, poll until it settles" flow that
// every Magica-backed tool (Crop Image, GPT Image 2, Merge Videos) shares.
// Server-to-server only: MAGICA_API_KEY must never reach client code, a
// prompt, a log line, or a persisted message.
//
// Endpoint shapes below are from Magica's published API reference
// (magica.com/docs/api-reference/nodes), not guessed: POST starts a run and
// returns only `runId`; GET polls and returns the full run record keyed by
// `id`, with `status` one of QUEUED/RUNNING/COMPLETED/FAILED/CANCELED.

const DEFAULT_BASE_URL = "https://inference.magica.com";
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;

export class MagicaError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "MagicaError";
  }
}

/** Terminal + non-terminal states a Magica run can be in, normalized to our own vocabulary. */
export type MagicaRunState = "pending" | "running" | "completed" | "failed";

export interface MagicaRunStatus {
  runId: string;
  state: MagicaRunState;
  output?: unknown;
  error?: string;
}

function requireApiKey(): string {
  const apiKey = process.env.MAGICA_API_KEY;
  if (!apiKey) throw new MagicaError("MAGICA_API_KEY is not set");
  return apiKey;
}

function baseUrl(): string {
  return process.env.MAGICA_BASE_URL ?? DEFAULT_BASE_URL;
}

/** POST /v1/nodes/{nodeType}/run — kicks off a node run, returns its id. */
export async function startRun(nodeType: string, input: unknown): Promise<string> {
  const res = await fetch(`${baseUrl()}/v1/nodes/${encodeURIComponent(nodeType)}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MagicaError(`Magica run failed to start (${res.status}): ${body}`, res.status);
  }

  const data = (await res.json()) as { runId?: string };
  if (!data.runId) throw new MagicaError("Magica did not return a run id");
  return data.runId;
}

/** GET /v1/nodes/runs/{runId} — one poll of a run's current state. */
export async function getRunStatus(runId: string): Promise<MagicaRunStatus> {
  const res = await fetch(`${baseUrl()}/v1/nodes/runs/${encodeURIComponent(runId)}`, {
    headers: { Authorization: `Bearer ${requireApiKey()}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MagicaError(`Magica poll failed (${res.status}): ${body}`, res.status);
  }

  const data = (await res.json()) as {
    status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED";
    output?: unknown;
    error?: string | null;
    userMessage?: string | null;
  };

  const state: MagicaRunState =
    data.status === "COMPLETED"
      ? "completed"
      : data.status === "FAILED" || data.status === "CANCELED"
        ? "failed"
        : data.status === "RUNNING"
          ? "running"
          : "pending"; // QUEUED

  return { runId, state, output: data.output, error: data.error ?? data.userMessage ?? undefined };
}

/**
 * Starts a node run and polls until it settles. Blocking by design — a tool's
 * execute() is synchronous from the agent loop's point of view, and the loop
 * itself runs inside a Trigger.dev task with a generous maxDuration, so
 * there's no serverless timeout to dodge here.
 *
 * `onState` fires on each state change so a caller can surface pending ->
 * running -> completed to the UI rather than a single opaque wait.
 */
export async function runNodeAndWait(
  nodeType: string,
  input: unknown,
  opts: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    onState?: (status: MagicaRunStatus) => void;
    signal?: AbortSignal;
  } = {},
): Promise<unknown> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const runId = await startRun(nodeType, input);
  const deadline = Date.now() + timeoutMs;
  let lastState: MagicaRunState | null = null;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new MagicaError("Magica run cancelled");

    const status = await getRunStatus(runId);
    if (status.state !== lastState) {
      lastState = status.state;
      opts.onState?.(status);
    }

    if (status.state === "completed") return status.output;
    if (status.state === "failed") {
      throw new MagicaError(status.error ?? `Magica run ${runId} failed`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new MagicaError(`Magica run ${runId} timed out after ${timeoutMs}ms`);
}
