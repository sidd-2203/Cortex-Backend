import { ApiError } from "./api-error";

// Opaque cursor for (timestamp, id) keyset pagination — base64("<ISO>|<id>").
// Deliberately opaque so it stays an implementation detail of whichever
// composite index backs a given list query, not a page number a client
// could tamper with meaningfully.

export function encodeCursor(timestamp: Date, id: string) {
  return Buffer.from(`${timestamp.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): { timestamp: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const parts = decoded.split("|");
  const iso = parts[0];
  const id = parts[1];
  const timestamp = iso ? new Date(iso) : null;

  if (parts.length !== 2 || !id || !timestamp || Number.isNaN(timestamp.getTime())) {
    throw new ApiError(400, "invalid_cursor", "Malformed pagination cursor");
  }
  return { timestamp, id };
}
