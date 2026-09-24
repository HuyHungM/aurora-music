import { describe, expect, it } from "vitest";
import {
  ExtractorError,
  NormalizationError,
  PlaybackResolutionError,
  QueueError,
  TrackMatchError,
  TrackNotFoundError,
  isEngineError,
  serializeEngineError,
} from "@/lib/domain/errors";

describe("Engine errors", () => {
  it("serializes extractor failures with provider and operation", () => {
    const error = new ExtractorError("youtube", "search", "timeout", {
      retryable: true,
    });
    expect(error.toJSON()).toEqual({
      name: "ExtractorError",
      code: "EXTRACTOR_ERROR",
      message: "timeout",
      retryable: true,
      provider: "youtube",
      details: { operation: "search" },
    });
  });

  it("marks normalization failures as non-retryable with field context", () => {
    const error = new NormalizationError("durationMs", "invalid duration");
    expect(error.retryable).toBe(false);
    expect(error.toJSON().details).toEqual({ field: "durationMs" });
  });

  it("serializes missing tracks with stable identity only", () => {
    const error = new TrackNotFoundError({
      provider: "spotify",
      providerTrackId: "s1",
    });
    expect(error.toJSON()).toMatchObject({
      name: "TrackNotFoundError",
      code: "TRACK_NOT_FOUND",
      provider: "spotify",
    });
  });

  it("records low-confidence matches without raw provider data", () => {
    const error = new TrackMatchError(
      { source: "spotify", id: "s1" },
      0.41,
    );
    const json = error.toJSON();
    expect(json.code).toBe("TRACK_MATCH_ERROR");
    expect(json.details).toMatchObject({ confidence: 0.41 });
    expect(JSON.stringify(json)).not.toContain("token");
  });

  it("distinguishes playback resolution stages", () => {
    const error = new PlaybackResolutionError(
      { provider: "deezer", providerTrackId: "d1" },
      "match",
      "no confident YouTube match",
    );
    expect(error.toJSON().details).toMatchObject({ stage: "match" });
  });

  it("serializes queue failures with operation context", () => {
    const error = new QueueError("remove", "index out of range");
    expect(error.toJSON()).toMatchObject({
      code: "QUEUE_ERROR",
      details: { operation: "remove" },
    });
  });

  it("narrowing and fallback serialization are JSON-safe", () => {
    expect(isEngineError(new QueueError("clear", "empty"))).toBe(true);
    expect(isEngineError(new Error("boom"))).toBe(false);
    const fallback = serializeEngineError("string failure");
    expect(fallback.code).toBe("ENGINE_ERROR");
    expect(() => JSON.stringify(serializeEngineError(new Error("x")))).not.toThrow();
  });

  it("never leaks secrets through serialization", () => {
    const error = new ExtractorError("spotify", "auth", "denied");
    const payload = JSON.stringify(error.toJSON());
    expect(payload).not.toContain("secret");
    expect(payload).not.toContain("token");
  });
});
