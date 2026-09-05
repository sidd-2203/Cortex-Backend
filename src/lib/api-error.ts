import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError } from "./auth";
import { logger, type LogContext } from "./logger";

/** Thrown by handlers for expected, user-facing failure conditions. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string) {
    super(404, "not_found", `${resource} not found`);
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = "You do not have access to this resource") {
    super(403, "forbidden", message);
  }
}

/**
 * Every route handler body should be wrapped in this so a failure always
 * produces a consistent { error: { code, message } } envelope instead of an
 * unhandled 500 with a leaked stack trace, and always gets a structured log
 * line carrying whatever correlation ids the caller has on hand.
 */
export async function withApiError<T>(
  ctx: LogContext,
  fn: () => Promise<T>,
): Promise<T | NextResponse> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ZodError) {
      logger.warn("request validation failed", { ...ctx, issues: err.issues });
      return NextResponse.json(
        { error: { code: "invalid_request", message: "Validation failed", issues: err.issues } },
        { status: 400 },
      );
    }
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: { code: "unauthorized", message: err.message } }, { status: 401 });
    }
    if (err instanceof ApiError) {
      logger.warn(err.message, { ...ctx, code: err.code });
      return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
    }
    logger.error(err instanceof Error ? err.message : "Unknown error", {
      ...ctx,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      { error: { code: "internal_error", message: "Something went wrong" } },
      { status: 500 },
    );
  }
}
