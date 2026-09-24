import { describe, expect, it } from "vitest";
import {
  fromTrackRef,
  isSourceType,
  sourceReferenceKey,
  toTrackRef,
} from "@/lib/domain/source-reference";

describe("SourceType", () => {
  it("accepts exactly the three production sources", () => {
    expect(isSourceType("youtube")).toBe(true);
    expect(isSourceType("spotify")).toBe(true);
    expect(isSourceType("deezer")).toBe(true);
  });

  it("rejects removed providers and non-strings", () => {
    expect(isSourceType("jamendo")).toBe(false);
    expect(isSourceType("zingmp3")).toBe(false);
    expect(isSourceType("audius")).toBe(false);
    expect(isSourceType("mock")).toBe(false);
    expect(isSourceType(undefined)).toBe(false);
    expect(isSourceType(null)).toBe(false);
    expect(isSourceType(42)).toBe(false);
  });
});

describe("SourceReference", () => {
  it("builds a stable source:id key", () => {
    expect(sourceReferenceKey({ source: "youtube", id: "abc123" })).toBe(
      "youtube:abc123",
    );
    expect(sourceReferenceKey({ source: "spotify", id: "abc123" })).not.toBe(
      sourceReferenceKey({ source: "youtube", id: "abc123" }),
    );
  });

  it("bridges to the existing TrackRef contract", () => {
    expect(toTrackRef({ source: "deezer", id: "d1" })).toEqual({
      provider: "deezer",
      providerTrackId: "d1",
    });
  });

  it("converts valid TrackRefs and rejects unknown providers", () => {
    expect(fromTrackRef({ provider: "youtube", providerTrackId: "v1" })).toEqual({
      source: "youtube",
      id: "v1",
    });
    expect(fromTrackRef({ provider: "jamendo", providerTrackId: "v1" })).toBeNull();
    expect(fromTrackRef({ provider: "youtube", providerTrackId: "" })).toBeNull();
  });
});
