import { AuroraError } from "@/lib/errors";
import type { TrackRef } from "./common";
import type { SourceReference } from "./source-reference";

/**
 * Music Engine domain errors.
 *
 * Adaptation note: `ProviderError` already exists in `@/lib/errors` and
 * `PlayerError` already exists in `@/lib/player/engine`; they are reused
 * and NOT redefined here to avoid duplicate architecture. This module adds
 * only the missing engine-specific failures and a shared serializable base.
 *
 * Every error exposes an explicit JSON-safe representation so failures can
 * cross server/client boundaries without relying on default `Error`
 * serialization. Serialized payloads never include secrets, tokens, or raw
 * provider responses.
 */

export type EngineErrorCode =
  | "ENGINE_ERROR"
  | "EXTRACTOR_ERROR"
  | "NORMALIZATION_ERROR"
  | "TRACK_NOT_FOUND"
  | "TRACK_MATCH_ERROR"
  | "PLAYBACK_RESOLUTION_ERROR"
  | "QUEUE_ERROR";

export interface SerializedEngineError {
  name: string;
  code: EngineErrorCode;
  message: string;
  retryable: boolean;
  provider?: string;
  details?: Record<string, string | number | boolean | null>;
}

export class EngineError extends AuroraError {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;

  constructor(
    code: EngineErrorCode,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super(message, options ? { cause: options.cause } : undefined);
    this.name = "EngineError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }

  toJSON(): SerializedEngineError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

function toDetails(
  value: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> | undefined {
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | number | boolean | null] =>
      entry[1] !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** A provider extractor failed (network, rate limit, malformed response). */
export class ExtractorError extends EngineError {
  readonly provider: string;
  readonly operation: string;

  constructor(
    provider: string,
    operation: string,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super("EXTRACTOR_ERROR", message, options);
    this.name = "ExtractorError";
    this.provider = provider;
    this.operation = operation;
  }

  toJSON(): SerializedEngineError {
    return {
      ...super.toJSON(),
      name: this.name,
      provider: this.provider,
      details: { operation: this.operation },
    };
  }
}

/** Provider data failed domain validation/normalization. Never retryable. */
export class NormalizationError extends EngineError {
  readonly field: string;

  constructor(field: string, message: string, options?: { cause?: unknown }) {
    super("NORMALIZATION_ERROR", message, { ...options, retryable: false });
    this.name = "NormalizationError";
    this.field = field;
  }

  toJSON(): SerializedEngineError {
    return {
      ...super.toJSON(),
      name: this.name,
      details: { field: this.field },
    };
  }
}

/** A stable track reference could not be resolved by its provider. */
export class TrackNotFoundError extends EngineError {
  readonly ref: TrackRef;

  constructor(ref: TrackRef, message = "Track not found") {
    super("TRACK_NOT_FOUND", message, { retryable: false });
    this.name = "TrackNotFoundError";
    this.ref = { provider: ref.provider, providerTrackId: ref.providerTrackId };
  }

  toJSON(): SerializedEngineError {
    return {
      ...super.toJSON(),
      name: this.name,
      provider: this.ref.provider,
      details: toDetails({ providerTrackId: this.ref.providerTrackId }),
    };
  }
}

/**
 * Cross-source matching refused to return a low-confidence substitute.
 * A low-confidence match is a failed match — never play a random result.
 */
export class TrackMatchError extends EngineError {
  readonly sourceRef: SourceReference;
  readonly confidence: number;

  constructor(sourceRef: SourceReference, confidence: number, message = "No confident match") {
    super("TRACK_MATCH_ERROR", message, { retryable: false });
    this.name = "TrackMatchError";
    this.sourceRef = {
      source: sourceRef.source,
      id: sourceRef.id,
    };
    this.confidence = confidence;
  }

  toJSON(): SerializedEngineError {
    return {
      ...super.toJSON(),
      name: this.name,
      provider: this.sourceRef.source,
      details: toDetails({
        sourceId: this.sourceRef.id,
        confidence: this.confidence,
      }),
    };
  }
}

export type PlaybackResolutionStage = "match" | "resolve" | "stream";

/** Playback resolution failed at a specific pipeline stage. */
export class PlaybackResolutionError extends EngineError {
  readonly trackRef: TrackRef;
  readonly stage: PlaybackResolutionStage;

  constructor(
    trackRef: TrackRef,
    stage: PlaybackResolutionStage,
    message: string,
    options?: { retryable?: boolean; cause?: unknown },
  ) {
    super("PLAYBACK_RESOLUTION_ERROR", message, options);
    this.name = "PlaybackResolutionError";
    this.trackRef = {
      provider: trackRef.provider,
      providerTrackId: trackRef.providerTrackId,
    };
    this.stage = stage;
  }

  toJSON(): SerializedEngineError {
    return {
      ...super.toJSON(),
      name: this.name,
      provider: this.trackRef.provider,
      details: toDetails({
        providerTrackId: this.trackRef.providerTrackId,
        stage: this.stage,
      }),
    };
  }
}

/** Queue state transition failed (invalid index, empty queue, bad op). */
export class QueueError extends EngineError {
  readonly operation: string;

  constructor(operation: string, message: string, options?: { cause?: unknown }) {
    super("QUEUE_ERROR", message, { ...options, retryable: false });
    this.name = "QueueError";
    this.operation = operation;
  }

  toJSON(): SerializedEngineError {
    return {
      ...super.toJSON(),
      name: this.name,
      details: { operation: this.operation },
    };
  }
}

/** Narrowing helper for engine error handling. */
export function isEngineError(error: unknown): error is EngineError {
  return error instanceof EngineError;
}

/**
 * Converts any thrown value into a JSON-safe engine error payload.
 * Unknown values map to a generic non-retryable ENGINE_ERROR.
 */
export function serializeEngineError(error: unknown): SerializedEngineError {
  if (error instanceof EngineError) {
    return error.toJSON();
  }
  if (error instanceof AuroraError) {
    return {
      name: error.name,
      code: "ENGINE_ERROR",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      code: "ENGINE_ERROR",
      message: error.message || "Unexpected error",
      retryable: false,
    };
  }
  return {
    name: "Error",
    code: "ENGINE_ERROR",
    message: "Unexpected error",
    retryable: false,
  };
}
