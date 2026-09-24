import { describe, expect, it } from "vitest";
import {
  EngineError,
  ExtractorError,
  NormalizationError,
  PlaybackResolutionError,
  TrackMatchError,
  TrackNotFoundError,
} from "@/lib/domain";
import { PlayerError } from "@/lib/player/engine";
import {
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_RETRY_DELAYS_MS,
  SEEK_STALL_GRACE_MS,
  STALL_PROGRESS_EPSILON_S,
  STALL_THRESHOLD_MS,
  classifyFailure,
  clampResumePosition,
  delayForRecoveryAttempt,
} from "@/lib/playback/recovery";

describe("recovery policy constants", () => {
  it("bounds attempts and orders backoff delays increasingly", () => {
    expect(MAX_RECOVERY_ATTEMPTS).toBe(2);
    expect(RECOVERY_RETRY_DELAYS_MS).toEqual([200, 800]);
    expect(delayForRecoveryAttempt(1)).toBe(200);
    expect(delayForRecoveryAttempt(2)).toBe(800);
    expect(delayForRecoveryAttempt(99)).toBe(800);
  });

  it("keeps recovery latency user-facing, not tens of seconds", () => {
    const total = RECOVERY_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeLessThan(5000);
  });

  it("uses conservative stall thresholds", () => {
    expect(STALL_THRESHOLD_MS).toBe(5000);
    expect(STALL_PROGRESS_EPSILON_S).toBe(0.25);
    expect(SEEK_STALL_GRACE_MS).toBe(2000);
  });
});

describe("clampResumePosition", () => {
  it("clamps beyond-duration positions when duration is known", () => {
    expect(clampResumePosition(250, 200)).toBe(200);
    expect(clampResumePosition(100, 200)).toBe(100);
  });

  it("passes through when duration is unknown", () => {
    expect(clampResumePosition(250, 0)).toBe(250);
    expect(clampResumePosition(100, Number.NaN)).toBe(100);
  });

  it("sanitizes non-finite or negative positions", () => {
    expect(clampResumePosition(Number.NaN, 200)).toBe(0);
    expect(clampResumePosition(-5, 200)).toBe(0);
  });
});

describe("classifyFailure", () => {
  it("never retries autoplay blocks (they need a gesture)", () => {
    expect(classifyFailure(new PlayerError("autoplay", "Tap play"))).toEqual({
      category: "autoplay",
      retryable: false,
    });
  });

  it("treats superseded loads as non-failures", () => {
    expect(
      classifyFailure(new PlayerError("playback", "aborted", 1)),
    ).toEqual({ category: "aborted", retryable: false });
  });

  it("maps media network errors to transient", () => {
    expect(
      classifyFailure(new PlayerError("playback", "net down", 2)),
    ).toEqual({ category: "transient", retryable: true });
  });

  it("maps decode and src-not-supported to source (fresh format may fix)", () => {
    expect(classifyFailure(new PlayerError("playback", "decode", 3))).toEqual({
      category: "source",
      retryable: true,
    });
    expect(
      classifyFailure(new PlayerError("unavailable", "nope", 4)),
    ).toEqual({ category: "source", retryable: true });
  });

  it("treats codeless unavailability as permanent", () => {
    expect(
      classifyFailure(new PlayerError("unavailable", "no stream")),
    ).toEqual({ category: "permanent", retryable: false });
  });

  it("treats generic mid-playback failures as transient", () => {
    expect(classifyFailure(new PlayerError("playback", "boom"))).toEqual({
      category: "transient",
      retryable: true,
    });
  });

  it("never retries match-stage resolution (no playable source)", () => {
    expect(
      classifyFailure(
        new PlaybackResolutionError(
          { provider: "spotify", providerTrackId: "x" },
          "match",
          "No playable source in this identity",
        ),
      ),
    ).toEqual({ category: "permanent", retryable: false });
  });

  it("honors the retryable flag on resolve-stage failures", () => {
    const ref = { provider: "youtube", providerTrackId: "v" };
    expect(
      classifyFailure(
        new PlaybackResolutionError(ref, "resolve", "timeout", {
          retryable: true,
        }),
      ),
    ).toEqual({ category: "transient", retryable: true });
    expect(
      classifyFailure(
        new PlaybackResolutionError(ref, "resolve", "private video"),
      ),
    ).toEqual({ category: "permanent", retryable: false });
  });

  it("honors the retryable flag on extractor errors", () => {
    expect(
      classifyFailure(
        new ExtractorError("youtube", "info", "reset", { retryable: true }),
      ),
    ).toEqual({ category: "transient", retryable: true });
    expect(
      classifyFailure(new ExtractorError("youtube", "info", "bad response")),
    ).toEqual({ category: "permanent", retryable: false });
  });

  it("treats validation failures as permanent", () => {
    expect(
      classifyFailure(new NormalizationError("providerTrackId", "bad id")),
    ).toEqual({ category: "permanent", retryable: false });
    expect(
      classifyFailure(
        new TrackNotFoundError({ provider: "youtube", providerTrackId: "x" }),
      ),
    ).toEqual({ category: "permanent", retryable: false });
    expect(
      classifyFailure(
        new TrackMatchError({ source: "youtube", id: "x" }, 0.1),
      ),
    ).toEqual({ category: "permanent", retryable: false });
  });

  it("honors generic retryable engine errors", () => {
    expect(
      classifyFailure(new EngineError("ENGINE_ERROR", "blip", { retryable: true })),
    ).toEqual({ category: "transient", retryable: true });
    expect(classifyFailure(new EngineError("ENGINE_ERROR", "bad"))).toEqual({
      category: "permanent",
      retryable: false,
    });
  });

  it("classifies unrecognized shapes as unknown and non-retryable", () => {
    expect(classifyFailure(new Error("weird"))).toEqual({
      category: "unknown",
      retryable: false,
    });
    expect(classifyFailure(undefined)).toEqual({
      category: "unknown",
      retryable: false,
    });
  });
});
