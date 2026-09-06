// Transloadit client — creates an Assembly (Stage 1 of a resumable/tus
// upload) and polls its status. Server-to-server only: TRANSLOADIT_SECRET
// must never reach client code, a prompt, a log line, or a persisted
// message. The actual file bytes never pass through our backend — the
// browser uploads them directly to Transloadit's tus endpoint, which is
// what keeps this off Vercel's function payload/duration limits entirely.
//
// Endpoint shapes and the signing algorithm below are from Transloadit's
// published docs (transloadit.com/docs/api/authentication,
// transloadit.com/docs/api/resumable-uploads), not guessed.

import crypto from "node:crypto";

const ASSEMBLIES_URL = "https://api2.transloadit.com/assemblies";
const SIGNATURE_TTL_MS = 5 * 60 * 1000;

export class TransloaditError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "TransloaditError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new TransloaditError(`${name} is not set`);
  return value;
}

/**
 * Signature Authentication: an RFC 6234 HMAC-SHA384 hex digest of the JSON
 * `params` string, keyed by the Auth Secret, prefixed with the algorithm
 * name. Required because the browser (untrusted environment) drives the
 * actual tus upload — this is what proves the assembly was authorized by us.
 */
function sign(params: Record<string, unknown>): { params: string; signature: string } {
  const json = JSON.stringify(params);
  const digest = crypto.createHmac("sha384", requireEnv("TRANSLOADIT_SECRET")).update(json, "utf-8").digest("hex");
  return { params: json, signature: `sha384:${digest}` };
}

export interface CreatedAssembly {
  assemblyId: string;
  /** Pass to the tus client as the `assembly_url` upload metadata field. */
  assemblySslUrl: string;
  /** The tus server endpoint to create the upload resource against. */
  tusUrl: string;
}

/** Stage 1 — creates an Assembly configured for exactly one resumable (tus) upload. */
export async function createAssembly(fields: Record<string, string> = {}): Promise<CreatedAssembly> {
  const expires = new Date(Date.now() + SIGNATURE_TTL_MS).toISOString().replace(/\.\d+Z$/, ".000Z");
  const { params, signature } = sign({
    auth: { key: requireEnv("TRANSLOADIT_KEY"), expires, nonce: crypto.randomUUID() },
    template_id: requireEnv("TRANSLOADIT_TEMPLATE_ID"),
    fields,
  });

  const form = new FormData();
  form.set("params", params);
  form.set("signature", signature);
  form.set("num_expected_upload_files", "1");

  const res = await fetch(ASSEMBLIES_URL, { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as {
    assembly_id?: string;
    assembly_ssl_url?: string;
    tus_url?: string;
    error?: string;
    message?: string;
  };

  if (!res.ok || data.error) {
    throw new TransloaditError(`Transloadit assembly creation failed: ${data.message ?? data.error ?? res.statusText}`, res.status);
  }
  if (!data.assembly_id || !data.assembly_ssl_url || !data.tus_url) {
    throw new TransloaditError("Transloadit did not return the expected assembly fields");
  }

  return { assemblyId: data.assembly_id, assemblySslUrl: data.assembly_ssl_url, tusUrl: data.tus_url };
}

export interface AssemblyResultFile {
  url: string;
  sslUrl: string;
  mime: string | null;
  name: string | null;
}

export interface AssemblyStatus {
  /** e.g. ASSEMBLY_UPLOADING, ASSEMBLY_EXECUTING, ASSEMBLY_COMPLETED, ASSEMBLY_FAILED */
  ok: string;
  isComplete: boolean;
  isFailed: boolean;
  error: string | null;
  /** Best-effort pick of the final output file — see extractResultFile(). */
  resultFile: AssemblyResultFile | null;
}

// Polling an Assembly's status needs no auth — the assembly_id itself is
// the unguessable capability, same as Magica's runId. Any machine-pinned
// hostname in assembly_ssl_url also works generically via api2.transloadit.com.
export async function getAssemblyStatus(assemblyId: string): Promise<AssemblyStatus> {
  const res = await fetch(`${ASSEMBLIES_URL}/${encodeURIComponent(assemblyId)}`);
  const data = (await res.json().catch(() => ({}))) as {
    ok?: string;
    error?: string;
    message?: string;
    results?: Record<string, AssemblyResultFileRaw[]>;
    uploads?: AssemblyResultFileRaw[];
  };

  if (!res.ok) {
    throw new TransloaditError(`Transloadit status lookup failed: ${data.message ?? res.statusText}`, res.status);
  }

  const ok = data.ok ?? "";
  const isFailed = ok.includes("ERROR") || ok.includes("FAILED") || ok === "ASSEMBLY_CANCELED";
  const isComplete = ok === "ASSEMBLY_COMPLETED";

  return {
    ok,
    isComplete,
    isFailed,
    error: isFailed ? (data.message ?? data.error ?? "Assembly failed") : null,
    resultFile: isComplete ? extractResultFile(data.results, data.uploads) : null,
  };
}

interface AssemblyResultFileRaw {
  url?: string;
  ssl_url?: string;
  mime?: string;
  name?: string;
}

/**
 * Picks the file to treat as "the" output of a single-file, single-output
 * template. `results` is keyed by step name — we don't know this account's
 * template's step names ahead of time, so this prefers the first step that
 * isn't the passthrough `:original`, and falls back to `:original` or the
 * raw upload if the template has no processing step at all. Verify this
 * against the real template once a working (non-Smart-CDN) Auth Key is in
 * place — see TRANSLOADIT setup notes.
 */
function extractResultFile(
  results: Record<string, AssemblyResultFileRaw[]> | undefined,
  uploads: AssemblyResultFileRaw[] | undefined,
): AssemblyResultFile | null {
  const stepNames = Object.keys(results ?? {});
  const preferredStep = stepNames.find((name) => name !== ":original") ?? stepNames.at(0);
  const raw: AssemblyResultFileRaw | undefined =
    (preferredStep !== undefined ? results?.[preferredStep]?.[0] : undefined) ?? uploads?.[0];
  if (!raw?.ssl_url) return null;
  return { url: raw.url ?? raw.ssl_url, sslUrl: raw.ssl_url, mime: raw.mime ?? null, name: raw.name ?? null };
}
