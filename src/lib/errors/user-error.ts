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
import type { Locale } from "@/lib/i18n/locale";
import { t } from "@/lib/i18n/translate";

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

/**
 * Phase 42: every user-facing message is an English canonical literal plus
 * its dictionary key. English callers (and all existing tests) see byte-
 * identical output; Vietnamese callers get the curated translation.
 * Internal codes, categories, and retry/preserve flags never localize.
 */
function msg(
  locale: Locale,
  en: string,
  key: Parameters<typeof t>[1],
): string {
  return locale === "vi" ? t(locale, key) : en;
}

function networkOrOffline(
  context?: UserErrorContext,
  locale: Locale = "en",
): UserFacingError {
  if (!isOnline(context)) {
    return {
      category: "offline",
      code: "OFFLINE",
      message: msg(
        locale,
        "You're offline. Music playback requires an internet connection.",
        "errors.offlineMessage",
      ),
      retryable: true,
      preservePlayback: true,
    };
  }
  return {
    category: "network",
    code: "NETWORK_UNAVAILABLE",
    message: msg(
      locale,
      "Couldn't reach the service. Check your connection and try again.",
      "errors.networkUnavailable",
    ),
    retryable: true,
    preservePlayback: true,
  };
}

const NETWORK_MESSAGE_PATTERN =
  /fetch failed|failed to fetch|networkerror|network request failed|timeout|timed out|econn|enotfound|offline|load failed/i;

function unknownError(locale: Locale = "en"): UserFacingError {
  return {
    category: "unknown",
    code: "UNKNOWN_ERROR",
    message: msg(
      locale,
      "Something went wrong. Please try again.",
      "errors.unknownError",
    ),
    retryable: true,
    preservePlayback: true,
  };
}

/**
 * Maps any thrown value to safe, deterministic UI content. Pure and
 * total: never throws, never leaks. The existing engine error classes
 * stay authoritative — this only translates them for display.
 * Pass the request locale for a translated message; categories, codes,
 * and flags are locale-independent and never change.
 */
export function toUserFacingError(
  error: unknown,
  context?: UserErrorContext,
  locale: Locale = "en",
): UserFacingError {
  if (error instanceof PlayerError) {
    // Engine diagnostics stay English-only at their source; the
    // Vietnamese UI shows the curated playback message instead.
    if (locale === "vi") {
      return {
        category: "playback-unavailable",
        code: "PLAYBACK_UNAVAILABLE",
        message: t(locale, "errors.playbackUnavailable"),
        retryable: true,
        preservePlayback: true,
      };
    }
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
        message: msg(
          locale,
          "That isn't available from the current sources right now.",
          "errors.providerUnavailable",
        ),
        retryable: false,
        preservePlayback: true,
      };
    }
    if (error.retryable) {
      return networkOrOffline(context, locale);
    }
    return {
      category: "provider-unavailable",
      code: "PROVIDER_UNAVAILABLE",
      message: msg(
        locale,
        "That track can't be played right now.",
        "errors.playbackUnavailable",
      ),
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof ExtractorError) {
    if (error.retryable) {
      return networkOrOffline(context, locale);
    }
    return {
      category: "provider-unavailable",
      code: "PROVIDER_UNAVAILABLE",
      message: msg(
        locale,
        "The music service didn't return that track.",
        "errors.providerEmpty",
      ),
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof TrackNotFoundError) {
    return {
      category: "not-found",
      code: "NOT_FOUND",
      message: msg(locale, "We couldn't find that.", "errors.notFoundMessage"),
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof TrackMatchError) {
    return {
      category: "provider-unavailable",
      code: "PROVIDER_UNAVAILABLE",
      message: msg(
        locale,
        "That isn't available right now.",
        "errors.matchUnavailable",
      ),
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof NormalizationError) {
    return {
      category: "validation",
      code: "VALIDATION_FAILED",
      message: msg(
        locale,
        "That request doesn't look right.",
        "errors.validationFailed",
      ),
      retryable: false,
      preservePlayback: true,
    };
  }
  if (error instanceof AuthorizationError) {
    return {
      category: "authentication",
      code: "AUTH_REQUIRED",
      message: msg(locale, "Please sign in to continue.", "errors.authRequired"),
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
        message: msg(locale, "Please sign in to continue.", "errors.authRequired"),
        retryable: false,
        preservePlayback: true,
      };
    }
    if (status === 404) {
      return {
        category: "not-found",
        code: "NOT_FOUND",
        message: msg(locale, "We couldn't find that.", "errors.notFoundMessage"),
        retryable: false,
        preservePlayback: true,
      };
    }
  }
  if (error instanceof AuroraError) {
    return unknownError(locale);
  }
  if (error instanceof Error) {
    if (NETWORK_MESSAGE_PATTERN.test(error.message)) {
      return networkOrOffline(context, locale);
    }
    return unknownError(locale);
  }
  if (typeof error === "string" && NETWORK_MESSAGE_PATTERN.test(error)) {
    return networkOrOffline(context, locale);
  }
  return unknownError(locale);
}
