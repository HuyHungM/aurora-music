import { describe, expect, it } from "vitest";
import {
  isQualifiedPlay,
  qualificationThresholdSeconds,
} from "@/lib/player/qualification";

describe("qualificationThresholdSeconds", () => {
  it("returns half the duration when shorter than the cap", () => {
    expect(qualificationThresholdSeconds(10)).toBe(5);
  });

  it("caps at 30 seconds for long tracks", () => {
    expect(qualificationThresholdSeconds(600)).toBe(30);
  });

  it("falls back to 30 seconds when duration is unknown", () => {
    expect(qualificationThresholdSeconds(undefined)).toBe(30);
    expect(qualificationThresholdSeconds(0)).toBe(30);
  });
});

describe("isQualifiedPlay", () => {
  it("qualifies only after playback actually started", () => {
    expect(isQualifiedPlay(10, 20, false)).toBe(false);
    expect(isQualifiedPlay(10, 20, true)).toBe(true);
  });

  it("qualifies once the playhead crosses the threshold", () => {
    expect(isQualifiedPlay(4, 10, true)).toBe(false);
    expect(isQualifiedPlay(5, 10, true)).toBe(true);
  });

  it("uses the 30-second floor for long tracks", () => {
    expect(isQualifiedPlay(29, 600, true)).toBe(false);
    expect(isQualifiedPlay(30, 600, true)).toBe(true);
  });

  it("never qualifies with invalid or negative playhead", () => {
    expect(isQualifiedPlay(-1, 10, true)).toBe(false);
    expect(isQualifiedPlay(Number.NaN, 10, true)).toBe(false);
    expect(isQualifiedPlay(Number.POSITIVE_INFINITY, 10, true)).toBe(false);
  });
});