import { describe, expect, it } from "vitest";
import { formatPlaybackTime, formatTrackDuration } from "@/lib/player/format";

/**
 * Adaptive track-duration labels. Input is SECONDS, matching
 * `Track.duration` (`identity-track.ts` divides `durationMs` by 1000 at
 * ingestion, so this never sees milliseconds).
 */
describe("formatTrackDuration", () => {
  it("formats sub-hour durations as zero-padded MM:SS", () => {
    expect(formatTrackDuration(0)).toBe("00:00");
    expect(formatTrackDuration(1)).toBe("00:01");
    expect(formatTrackDuration(3)).toBe("00:03");
    expect(formatTrackDuration(42)).toBe("00:42");
    expect(formatTrackDuration(59)).toBe("00:59");
    expect(formatTrackDuration(60)).toBe("01:00");
    expect(formatTrackDuration(61)).toBe("01:01");
    expect(formatTrackDuration(222)).toBe("03:42");
    expect(formatTrackDuration(2527)).toBe("42:07");
    expect(formatTrackDuration(3599)).toBe("59:59");
  });

  it("adds the hour component only when hours are non-zero", () => {
    expect(formatTrackDuration(3600)).toBe("01:00:00");
    expect(formatTrackDuration(3661)).toBe("01:01:01");
    expect(formatTrackDuration(3754)).toBe("01:02:34");
    expect(formatTrackDuration(36307)).toBe("10:05:07");
    expect(formatTrackDuration(360942)).toBe("100:15:42");
  });

  it("never emits a leading 00: hour component", () => {
    // The whole point of adaptive formatting: a three-minute song is
    // "03:42", not "00:03:42".
    expect(formatTrackDuration(222)).not.toMatch(/^00:/);
    expect(formatTrackDuration(2527)).not.toMatch(/^00:/);
    expect(formatTrackDuration(3599)).not.toMatch(/^00:/);
  });

  it("floors fractional seconds rather than leaking decimals", () => {
    expect(formatTrackDuration(222.9)).toBe("03:42");
    expect(formatTrackDuration(59.5)).toBe("00:59");
  });

  it("hides unknown durations instead of printing a fake value", () => {
    expect(formatTrackDuration(undefined)).toBe("");
    expect(formatTrackDuration(Number.NaN)).toBe("");
    expect(formatTrackDuration(-1)).toBe("");
    expect(formatTrackDuration(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatTrackDuration(Number.NEGATIVE_INFINITY)).toBe("");
  });
});

describe("formatPlaybackTime", () => {
  it("keeps the player M:SS clock with a 0:00 fallback", () => {
    // Untouched by adaptive formatting: the player clock shows elapsed/total
    // where "0:00" is a genuine zero, not an unknown.
    expect(formatPlaybackTime(0)).toBe("0:00");
    expect(formatPlaybackTime(65)).toBe("1:05");
    expect(formatPlaybackTime(Number.NaN)).toBe("0:00");
    expect(formatPlaybackTime(-5)).toBe("0:00");
  });
});
