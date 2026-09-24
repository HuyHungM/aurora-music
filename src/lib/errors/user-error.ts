import {
  AuroraError,
  AuthorizationError,
} from "@/lib/errors";
import {
  ExtractorError,
  NormalizationError,
  PlaybackResolutionError,
  TrackMatchError,
  TrackNotFoundError,
} from "@/lib/domain";
import { PlayerError } from "@/lib/player/engine";

/**
 * User-facing error taxonomy (Phase 21). A single deterministic mapping
 * layer for UI surfaces (boundaries, offline indicator, retry affordances).
 *
 * Transport errors (engine/resolver) are already sanitized at their source
 * and keep flowing through the existing playback state; this module maps
 * ARBITRARY thrown values into safe UI content. Curated messages only —
 * the only passthrough is PlayerError, whose messages are constructed
 * user-safe literals, and even those are URL-scrubbed defensively.
 */

export type UserErrorCategory =
  | "network"
  | "offline"
  | "authentication"
  | "not-found"
  | "unsupported"
  | "playback-unavailable"
  | "provider-unavailable"
  | "validation"
  | "unknown";

export type UserErrorCode =
  | "NETWORK_UNAVAILABLE"
  | "OFFLINE"
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "UNSUPPORTED_OPERATION"
  | "PLAYBACK_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "VALIDATION_FAILED"
  | "UNKNOWN_ERROR";

export interface UserFacingError {
  category: UserErrorCategory;
  /** Stable, log-safe code (no internals, safe to persist in reports). */
  code: UserErrorCode;
  /** Curated UI text. Never contains URLs, tokens, or stacks. */
  message: string;
  /** Whether an explicit user retry action is sensible. */
  retryable: boolean;
  /** UI retries must never reset playback; always true by contract. */
  preservePlayback: boolean;
}

export interface UserErrorContext {
  /** Browser online state when known. Defaults to online outside browsers. */
  online?: boolean;
}

function isOnline(context?: UserErrorContext): boolean {
  if (context?.online !== undefined) {
    return context.online;
  }
  if (typeof navigator === "undefined") {
    return true;
  }
  return navigator.onLine !== false;
}

/** Removes URL-shaped content defensively (tokens/cookies travel in URLs). */
function sanitizeMessage(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "[removed]")
    .replace(/www\.\S+\.\S+/g, "[removed]");
}

function networkOrOffline(context?: UserErrorContext): UserFacingError {
  if (!isOnline(context)) {
    return {
      category: "offline",
      code: "OFFLINE",
      message:
        "You're offline. Music playback requires an internet connection.",
      retryable: true,
      preservePlayback: true,
    };
  }
  return {
    category: "network",
    code: "NETWORK_UNAVAILABLE",
    message: "Couldn't reach the service. Check your connection and try again.",
    retryable: true,
    preservePlayback: true,
  };
}

const NETWORK_MESSAGE_PATTERN =
  /fetch failed|failed to fetch|networkerror|network request failed|timeout|timed out|econn|enotfound|offline|load failed/i;

function unknownError(): UserFacingError {
  return {
    category: "unknown",
    code: "UNKNOWN_ERROR",
    message: "Something went wrong. Please try again.",
    retryable: true,
    preservePlayback: true,
  };
}

/**
 * Maps any thrown value to safe, deterministic UI content. Pure and
 * total: never throws, never leaks. The existing engine error classes
 * stay authoritative — this only translates them for display.
 */
export function toUserFacingError(
  error: unknown,
  context?: UserErrorContext,
): UserFacingError {
  if (error instanceof PlayerError) {
    return {
      category: "playback-unavailable",
      code: "PLAYBACK_UNAVAILABLE",
      message: sanitizeMessage(error.message),
      retryable: true,
      preservePlayback: true,
    };
  }
  if (error instanceof PlaybackResolutionError) {
    if (error.stage === "match") {
      return {
        category: "provider-unavailable",
        code: "PROVIDER_UNAVAILABLE",
        message: "That isn't available from the current sources right now.",
        retryable: false,
        preservePlayback: true,
      };
    }
    if (error.retryable) {
      return networkOrOffline(context);
    }
    return {
      category: "provider-unavailable",
      code: "PROVIDER_UNAVAILABLE",
      message: "That track can't be played right now.",
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof ExtractorError) {
    if (error.retryable) {
      return networkOrOffline(context);
    }
    return {
      category: "provider-unavailable",
      code: "PROVIDER_UNAVAILABLE",
      message: "The music service didn't return that track.",
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof TrackNotFoundError) {
    return {
      category: "not-found",
      code: "NOT_FOUND",
      message: "We couldn't find that.",
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof TrackMatchError) {
    return {
      category: "provider-unavailable",
      code: "PROVIDER_UNAVAILABLE",
      message: "That isn't available right now.",
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof NormalizationError) {
    return {
      category: "validation",
      code: "VALIDATION_FAILED",
      message: "That request doesn't look right.",
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof AuthorizationError) {
    return {
      category: "authentication",
      code: "AUTH_REQUIRED",
      message: "Please sign in to continue.",
      retryable: false,
      preservePlayback: true,
    };
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    const status = (error as { status: number }).status;
    if (status === 401 || status === 403) {
      return {
        category: "authentication",
        code: "AUTH_REQUIRED",
        message: "Please sign in to continue.",
        retryable: false,
        preservePlayback: true,
      };
    }
    if (status === 404) {
      return {
        category: "not-found",
        code: "NOT_FOUND",
        message: "We couldn't find that.",
        retryable: false,
        preservePlayback: true,
      };
    }
  }
  if (error instanceof AuroraError) {
    return unknownError();
  }
  if (error instanceof Error) {
    if (NETWORK_MESSAGE_PATTERN.test(error.message)) {
      return networkOrOffline(context);
    }
    return unknownError();
  }
  if (typeof error === "string" && NETWORK_MESSAGE_PATTERN.test(error)) {
    return networkOrOffline(context);
  }
  return unknownError();
}
