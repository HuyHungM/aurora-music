import { describe, expect, it, vi } from "vitest";
import { TrackNotFoundError } from "@/lib/domain";
import { UnsupportedProviderCapabilityError } from "@/lib/errors";
import { asExtractor, isPlayableExtractor } from "@/lib/providers/extractor";
import { makeFakeProvider } from "./fake-provider";

const YT_ID = "dQw4w9WgXcQ";

describe("asExtractor", () => {
  it("exposes the provider id as the extractor name", () => {
    expect(asExtractor(makeFakeProvider("youtube")).name).toBe("youtube");
  });

  it("validates only urls owned by its provider", () => {
    const extractor = asExtractor(makeFakeProvider("youtube"));
    expect(extractor.validate(`https://youtu.be/${YT_ID}`)).toBe(true);
    expect(
      extractor.validate("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3"),
    ).toBe(false);
    expect(extractor.validate("Lạc Trôi")).toBe(false);
  });

  it("delegates search to the provider", async () => {
    const extractor = asExtractor(makeFakeProvider("youtube"));
    const result = await extractor.search({ query: "Lạc Trôi" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.provider).toBe("youtube");
  });

  it("returns tracks on lookup", async () => {
    const extractor = asExtractor(makeFakeProvider("spotify"));
    const track = await extractor.getTrack("spotify-t1");
    expect(track?.title).toBe("Track spotify-t1");
  });

  it("lets TrackNotFoundError pass through unwrapped", async () => {
    const extractor = asExtractor(makeFakeProvider("spotify"));
    await expect(extractor.getTrack("missing")).rejects.toBeInstanceOf(
      TrackNotFoundError,
    );
  });

  it("wraps generic provider failures in ExtractorError", async () => {
    const extractor = asExtractor(
      makeFakeProvider("deezer", { failTrack: true }),
    );
    await expect(extractor.getTrack("deezer-t1")).rejects.toMatchObject({
      name: "ExtractorError",
      code: "EXTRACTOR_ERROR",
    });
  });

  it("never invokes unsupported methods and reports them explicitly", async () => {
    const provider = makeFakeProvider("deezer", { without: ["albums.get"] });
    const spy = vi.spyOn(provider, "getAlbum");
    const extractor = asExtractor(provider);
    await expect(extractor.getAlbum?.("a1")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("delegates album and artist lookup when supported", async () => {
    const extractor = asExtractor(makeFakeProvider("youtube"));
    await expect(extractor.getAlbum?.("al1")).resolves.toMatchObject({
      id: "al1",
    });
    await expect(extractor.getArtist?.("a1")).resolves.toMatchObject({
      id: "a1",
    });
  });
});

describe("isPlayableExtractor", () => {
  it("is false for metadata-only adapters", () => {
    expect(isPlayableExtractor(asExtractor(makeFakeProvider("spotify")))).toBe(
      false,
    );
    expect(isPlayableExtractor(asExtractor(makeFakeProvider("deezer")))).toBe(
      false,
    );
  });

  it("is true only when resolve is implemented", () => {
    const extractor = {
      ...asExtractor(makeFakeProvider("youtube")),
      resolve: async () => ({ url: "https://stream.example/t.mp3" }),
    };
    expect(isPlayableExtractor(extractor)).toBe(true);
  });
});
