import { randomUUID } from "node:crypto";

// Structured logging: every log line is one JSON object so failures are
// explainable from correlated ids alone (chatId/runId/messageId/traceId/...),
// per the reliability requirements. Swap the `write` implementation for a
// real sink (Axiom/Datadog/etc.) later without touching call sites.

export interface LogContext {
  traceId?: string;
  chatId?: string;
  runId?: string;
  messageId?: string;
  processId?: string;
  waitpointTokenId?: string;
  toolName?: string;
  [key: string]: unknown;
}

function write(level: "info" | "warn" | "error", message: string, ctx: LogContext = {}) {
  const line = {
    level,
    message,
    time: new Date().toISOString(),
    ...ctx,
  };
  // eslint-disable-next-line no-console
  console[level === "info" ? "log" : level](JSON.stringify(line));
}

export const logger = {
  info: (message: string, ctx?: LogContext) => write("info", message, ctx),
  warn: (message: string, ctx?: LogContext) => write("warn", message, ctx),
  error: (message: string, ctx?: LogContext) => write("error", message, ctx),
};

export function newTraceId() {
  return randomUUID();
}
