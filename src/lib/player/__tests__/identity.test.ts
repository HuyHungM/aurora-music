import { describe, expect, it } from "vitest";
import { sameTrack, trackKey } from "@/lib/player/identity";
import { makePlayableTrack } from "./fake-audio";

describe("trackKey", () => {
  it("combines provider and id into a stable identity", () => {
    expect(trackKey({ id: "123", provider: "jamendo" })).toBe("jamendo:123");
    expect(trackKey({ id: "123", provider: "mock" })).toBe("mock:123");
  });

  it("keeps same ids across different providers distinct", () => {
    expect(trackKey({ provider: "jamendo", id: "42" })).not.toBe(
      trackKey({ provider: "mock", id: "42" }),
    );
  });
});

describe("sameTrack", () => {
  it("detects the same provider+id", () => {
    const a = makePlayableTrack("1");
    expect(sameTrack(a, { provider: "jamendo", id: "1" })).toBe(true);
  });

  it("rejects different provider or id", () => {
    const a = makePlayableTrack("1");
    expect(sameTrack(a, { provider: "mock", id: "1" })).toBe(false);
    expect(sameTrack(a, { provider: "jamendo", id: "2" })).toBe(false);
  });

  it("handles nullish inputs", () => {
    expect(sameTrack(null, { provider: "jamendo", id: "1" })).toBe(false);
    expect(sameTrack(makePlayableTrack("1"), null)).toBe(false);
  });
});