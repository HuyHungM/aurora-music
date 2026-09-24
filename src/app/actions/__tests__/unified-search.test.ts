import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Track } from "@/lib/domain";
import { clearProviders, registerProvider } from "@/lib/providers/registry";
import {
  makeFakeProvider,
  makeTrack,
} from "@/lib/providers/__tests__/fake-provider";
import { searchUnifiedTracksAction } from "@/app/actions/unified-search";

function sameSong(provider: string, id: string): Track {
  return {
    ...makeTrack(provider, id, "Lạc Trôi"),
    artistId: "st-1",
    artistName: "Sơn Tùng M-TP",
    duration: 243,
    providerUrl: `https://example.invalid/${provider}/${id}`,
  };
}

describe("searchUnifiedTracksAction", () => {
  beforeEach(() => {
    clearProviders();
  });

  afterEach(() => {
    clearProviders();
  });

  it("returns one merged group per canonical track", async () => {
    registerProvider(
      makeFakeProvider("youtube", { tracks: [sameSong("youtube", "yt-1")] }),
    );
    registerProvider(
      makeFakeProvider("spotify", { tracks: [sameSong("spotify", "sp-1")] }),
    );
    const result = await searchUnifiedTracksAction("Lạc Trôi");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.result.query).toBe("Lạc Trôi");
    expect(result.result.succeeded).toBe(true);
    expect(result.result.partial).toBe(false);
    expect(result.result.tracks).toHaveLength(1);
    expect(
      result.result.tracks[0]?.sources.map((source) => source.source).sort(),
    ).toEqual(["spotify", "youtube"]);
  });

  it("keeps results when one provider fails", async () => {
    registerProvider(
      makeFakeProvider("youtube", { tracks: [sameSong("youtube", "yt-1")] }),
    );
    registerProvider(makeFakeProvider("deezer", { failSearch: true }));
    const result = await searchUnifiedTracksAction("x");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.result.succeeded).toBe(true);
    expect(result.result.partial).toBe(true);
    expect(result.result.tracks).toHaveLength(1);
  });

  it("reports failure when every provider fails", async () => {
    registerProvider(makeFakeProvider("youtube", { failSearch: true }));
    const result = await searchUnifiedTracksAction("x");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.result.succeeded).toBe(false);
    expect(result.result.tracks).toEqual([]);
  });

  it("returns empty success for valid queries with no hits", async () => {
    registerProvider(makeFakeProvider("youtube", { tracks: [] }));
    const result = await searchUnifiedTracksAction("zzz-no-match");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.result.succeeded).toBe(true);
    expect(result.result.tracks).toEqual([]);
  });

  it("rejects blank queries without fan-out", async () => {
    registerProvider(makeFakeProvider("youtube"));
    const result = await searchUnifiedTracksAction("   ");
    expect(result.ok).toBe(false);
  });

  it("returns plain serializable data", async () => {
    registerProvider(
      makeFakeProvider("youtube", { tracks: [sameSong("youtube", "yt-1")] }),
    );
    registerProvider(makeFakeProvider("deezer", { failSearch: true }));
    const result = await searchUnifiedTracksAction("x");
    expect(result.ok).toBe(true);
    const seguro = JSON.parse(JSON.stringify(result));
    expect(seguro).toEqual(JSON.parse(JSON.stringify(result)));
    if (result.ok) {
      expect(typeof result.result.query).toBe("string");
      expect(Array.isArray(result.result.tracks)).toBe(true);
      expect(typeof result.result.diagnostics.groups).toBe("number");
    }
  });
});
