/**
 * Request correlation ids (Phase 52, RULE 34).
 *
 * Purpose: when a user reports "it failed a minute ago", one identifier has to
 * connect the browser console line, the server log record and the error body
 * they pasted. Before this module the only correlation available was a
 * timestamp and a message, which is not correlation.
 *
 * Two rules make this safe:
 *
 * 1. Never derived from anything secret. The value is either freshly generated
 *    randomness or an inbound header that has passed a strict charset and
 *    length allowlist. A `crypto.randomUUID()` cannot carry a session id, an
 *    OAuth token, a cookie or a query string, and an inbound value that fails
 *    the allowlist is discarded rather than sanitized, because "sanitizing" a
 *    hostile value is how redaction bugs happen.
 *
 * 2. Never trusted for identity. A request id is a label, not an identity. It
 *    grants nothing, authorizes nothing, and is never written to the database.
 *
 * Generation uses `crypto.randomUUID()` where available and falls back to
 * `crypto.getRandomValues`; there is no `Math.random` path, because a
 * predictable correlation id is a log-injection vector.
 */

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export const REQUEST_ID_HEADER = "x-request-id";
/** The response header that echoes the id back to the caller. */
export const REQUEST_ID_RESPONSE_HEADER = "x-aurora-request-id";

/** Maximum length of an inbound id we are willing to echo. */
export const MAX_INBOUND_REQUEST_ID_LENGTH = 64;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  const webcrypto = globalThis.crypto;
  if (!webcrypto || typeof webcrypto.getRandomValues !== "function") {
    throw new Error(
      "No cryptographic randomness is available; refusing to mint a predictable request id.",
    );
  }
  webcrypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** A fresh, unguessable correlation id. Never throws in practice. */
export function newRequestId(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.randomUUID === "function") {
    return webcrypto.randomUUID();
  }
  // 128 bits, same shape class as a UUIDv4 minus the version nibbles: the
  // charset and length are what downstream log tooling matches on.
  return `aurora-${randomHex(16)}`;
}

/**
 * Normalize a caller-supplied id.
 *
 * Returns the value only if it is 8-64 characters of `[A-Za-z0-9._-]` -
 * a shape a reverse proxy or a client library naturally produces - and
 * otherwise returns a fresh id. A value containing newlines, spaces, quotes or
 * control characters is rejected outright rather than stripped, so a caller
 * cannot inject a second log line or split a response header.
 */
export function normalizeRequestId(value: string | null | undefined): string {
  if (typeof value === "string" && value.length <= MAX_INBOUND_REQUEST_ID_LENGTH) {
    const trimmed = value.trim();
    if (SAFE_ID.test(trimmed)) {
      return trimmed;
    }
  }
  return newRequestId();
}

/**
 * Pull a correlation id out of an inbound request. Safe to call with `null`
 * (e.g. a synthetic call from a test or a non-HTTP entry point).
 */
export function requestIdFromHeaders(
  headers: Pick<Headers, "get"> | null | undefined,
): string {
  if (!headers || typeof headers.get !== "function") {
    return newRequestId();
  }
  let raw: string | null = null;
  try {
    raw = headers.get(REQUEST_ID_HEADER);
  } catch {
    raw = null;
  }
  return normalizeRequestId(raw);
}
