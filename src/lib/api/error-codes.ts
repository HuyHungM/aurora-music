/**
 * Stable, client-facing error contract (Phase 52, RULE 33).
 *
 * Before this module every failure that crossed a server boundary was one of
 * two things: a hand-written English string chosen at the call site, or a raw
 * serialized domain error. A future Android/iOS/desktop client had nothing
 * stable to branch on - it could only pattern-match prose, which is not a
 * contract and changes when someone rewords a message.
 *
 * So: one closed set of codes, one mapping from the existing internal error
 * hierarchy onto that set, and one place that decides retryability. Internal
 * domain functions are NOT forced through this envelope (RULE 28) - this is the
 * transport boundary only, and the existing `AuroraError` hierarchy is
 * untouched.
 *
 * Invariants:
 * - The code set is closed. Adding a code is a deliberate contract change.
 * - `message` is a safe, human-readable string. Never a stack, a URL, a query
 *   parameter, a provider payload or an internal identifier.
 * - `retryable` is a promise about the *operation*, not about our mood: a
 *   network blip and an upstream provider outage are retryable; a malformed
 *   request and a permission failure never are.
 * - Mapping is total. Anything unrecognized becomes INTERNAL_ERROR with a fixed
 *   message, so an unexpected throw can never leak its own text to a client.
 */

import {
  AuthenticationError,
  AuthorizationError,
  AuroraError,
  ConflictError,
  ProviderError,
  ProviderRateLimitError,
  ResourceNotFoundError,
} from "@/lib/errors";
import { API_CONTRACT_VERSION } from "@/lib/api/contract-version";
import { newRequestId } from "@/lib/api/request-id";

/** The complete, closed set of codes a client may receive. */
export const CLIENT_ERROR_CODES = [
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "CONFLICT",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "PLAYBACK_UNAVAILABLE",
  "NETWORK_ERROR",
  /**
   * A server-side kill switch is off for this feature. Added because none of
   * the other codes is truthful here: the request was valid, the caller is
   * authorized, nothing is broken, and the resource is not absent.
   *
   * `retryable: true` is a statement about the deployment, not the caller's
   * input - a kill switch is by nature "off right now", and the deployment may
   * restore it. Clients should treat this as "this feature is unavailable,
   * hide the surface", not as an error worth showing to a listener.
   */
  "FEATURE_DISABLED",
  "INTERNAL_ERROR",
] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

/** Every code, with the HTTP status and retryability a transport should use. */
export interface ClientErrorSpec {
  readonly status: number;
  readonly retryable: boolean;
}

export const CLIENT_ERROR_SPECS: {
  readonly [K in ClientErrorCode]: ClientErrorSpec;
} = {
  // 401: the caller is not signed in. Retrying without signing in cannot help.
  AUTH_REQUIRED: { status: 401, retryable: false },
  // 403: signed in, but not permitted. Never worth an automatic retry.
  FORBIDDEN: { status: 403, retryable: false },
  // 404 for a genuinely absent resource, 409 for a conflict we choose to
  // report as such; NOT_FOUND is never used to hide existence from a caller
  // that is already authorized to ask (see docs/security.md).
  NOT_FOUND: { status: 404, retryable: false },
  VALIDATION_ERROR: { status: 400, retryable: false },
  CONFLICT: { status: 409, retryable: false },
  // 429: the caller asked for more than the operation allows. Retryable, and
  // the response must carry a Retry-After hint.
  RATE_LIMITED: { status: 429, retryable: true },
  // 502: an upstream music provider failed. Aurora is fine; the dependency is
  // not, so a later attempt genuinely can succeed.
  PROVIDER_UNAVAILABLE: { status: 502, retryable: true },
  // 422: we understood the request and could not produce playable audio for
  // it. Retrying the identical request will not help.
  PLAYBACK_UNAVAILABLE: { status: 422, retryable: false },
  // 503: we could not reach our own dependencies.
  NETWORK_ERROR: { status: 503, retryable: true },
  // 503 with retryable: a feature is switched off server-side, not missing.
  FEATURE_DISABLED: { status: 503, retryable: true },
  // 500. The only code whose message is ever fully generic.
  INTERNAL_ERROR: { status: 500, retryable: false },
};

export interface ClientErrorPayload {
  readonly code: ClientErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Field-level validation detail. Never present for INTERNAL_ERROR. */
  readonly details?: readonly string[];
}

export interface ClientErrorBody {
  readonly error: ClientErrorPayload;
  readonly meta: {
    readonly apiVersion: string;
    readonly requestId: string;
  };
}

/** Fixed, information-free text. The only message INTERNAL_ERROR may use. */
export const INTERNAL_ERROR_MESSAGE = "Something went wrong on our side.";

/**
 * Additional client-safe text the contract requires but the internal hierarchy
 * has no class for. Declared here rather than thrown as bespoke Errors so the
 * closed set stays closed.
 */
export class RateLimitError extends AuroraError {
  readonly retryAfterMs: number;
  readonly scope: string;

  constructor(scope: string, retryAfterMs: number, message?: string) {
    super(message ?? "Too many requests. Please slow down.");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.scope = scope;
  }
}

export class NetworkError extends AuroraError {
  constructor(message = "Could not reach the service.") {
    super(message);
    this.name = "NetworkError";
  }
}

/** Playback-specific failure that is not an upstream-provider failure. */
export class PlaybackUnavailableError extends AuroraError {
  constructor(message = "This track cannot be played right now.") {
    super(message);
    this.name = "PlaybackUnavailableError";
  }
}

export class ValidationError extends AuroraError {
  readonly details: string[];

  constructor(message = "The request was not valid.", details: string[] = []) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

/** Raised when a server-side kill switch is off for the requested feature. */
export class FeatureDisabledError extends AuroraError {
  readonly feature: string;

  constructor(feature: string, message?: string) {
    super(message ?? "This feature is temporarily unavailable.");
    this.name = "FeatureDisabledError";
    this.feature = feature;
  }
}

export interface ClassifyOptions {
  /**
   * Field-level detail to attach to a VALIDATION_ERROR. Only ever pass strings
   * that name a field, never the rejected value: a validation error that echoes
   * the input is a validation error that echoes a password.
   */
  readonly details?: readonly string[];
  /** Overrides the derived message. Must already be client-safe. */
  readonly message?: string;
}

function validationDetails(error: AuroraError): readonly string[] {
  if (error instanceof ValidationError) {
    return error.details;
  }
  if ("details" in error && Array.isArray((error as { details?: unknown }).details)) {
    const details = (error as { details: unknown[] }).details;
    if (details.every((entry): entry is string => typeof entry === "string")) {
      return details;
    }
  }
  return [];
}

/**
 * Total mapping from the internal error hierarchy onto the closed client set.
 *
 * Order matters only where a subclass would otherwise be caught by its parent:
 * `ProviderRateLimitError` and `AuthenticationError` are checked ahead of
 * `ProviderError` and `AuroraError` respectively.
 */
export function classifyError(error: unknown, options: ClassifyOptions = {}): ClientErrorPayload {
  const spec = (code: ClientErrorCode) => ({
    code,
    message: options.message ?? defaultMessage(code),
    retryable: CLIENT_ERROR_SPECS[code].retryable,
    ...(code === "VALIDATION_ERROR" && options.details && options.details.length > 0
      ? { details: options.details }
      : {}),
  });

  if (error instanceof RateLimitError) {
    return spec("RATE_LIMITED");
  }
  if (error instanceof FeatureDisabledError) {
    return spec("FEATURE_DISABLED");
  }
  if (error instanceof NetworkError) {
    return spec("NETWORK_ERROR");
  }
  if (error instanceof PlaybackUnavailableError) {
    return spec("PLAYBACK_UNAVAILABLE");
  }
  if (error instanceof ValidationError) {
    return { ...spec("VALIDATION_ERROR"), details: validationDetails(error) };
  }
  if (error instanceof AuthenticationError) {
    return spec("AUTH_REQUIRED");
  }
  if (error instanceof AuthorizationError) {
    return spec("FORBIDDEN");
  }
  if (error instanceof ResourceNotFoundError) {
    return spec("NOT_FOUND");
  }
  if (error instanceof ConflictError) {
    return spec("CONFLICT");
  }
  if (error instanceof ProviderRateLimitError) {
    // An upstream quota failure is a provider outage from the caller's point of
    // view, not a reason for the caller to back off and retry sooner.
    return spec("PROVIDER_UNAVAILABLE");
  }
  if (error instanceof ProviderError) {
    return spec("PROVIDER_UNAVAILABLE");
  }
  if (error instanceof AuroraError) {
    // A ConfigError and anything else internal: report the class, not the text.
    return spec("INTERNAL_ERROR");
  }
  return spec("INTERNAL_ERROR");
}

function defaultMessage(code: ClientErrorCode): string {
  switch (code) {
    case "AUTH_REQUIRED":
      return "You must be signed in to do that.";
    case "FORBIDDEN":
      return "You are not allowed to do that.";
    case "NOT_FOUND":
      return "That could not be found.";
    case "VALIDATION_ERROR":
      return "The request was not valid.";
    case "CONFLICT":
      return "That change conflicts with the current state. Reload and try again.";
    case "RATE_LIMITED":
      return "Too many requests. Please slow down.";
    case "PROVIDER_UNAVAILABLE":
      return "A music provider is unavailable right now. Try again shortly.";
    case "PLAYBACK_UNAVAILABLE":
      return "This track cannot be played right now.";
    case "NETWORK_ERROR":
      return "Could not reach the service.";
    case "FEATURE_DISABLED":
      return "This feature is temporarily unavailable.";
    case "INTERNAL_ERROR":
      return INTERNAL_ERROR_MESSAGE;
  }
}

/**
 * Build the full error body, including the correlation id. This is the only
 * function that constructs a `ClientErrorBody`.
 */
export function toClientErrorBody(
  error: unknown,
  options: ClassifyOptions & { requestId?: string } = {},
): ClientErrorBody {
  const payload = classifyError(error, options);
  const body: ClientErrorPayload =
    payload.code === "INTERNAL_ERROR"
      ? // Last line of defence: an INTERNAL_ERROR never carries caller-supplied
        // detail, even if a call site passed some.
        { code: payload.code, message: INTERNAL_ERROR_MESSAGE, retryable: false }
      : payload;
  return {
    error: body,
    meta: {
      apiVersion: API_CONTRACT_VERSION,
      requestId: options.requestId ?? newRequestId(),
    },
  };
}

export function isClientErrorCode(value: unknown): value is ClientErrorCode {
  return (
    typeof value === "string" &&
    (CLIENT_ERROR_CODES as readonly string[]).includes(value)
  );
}
