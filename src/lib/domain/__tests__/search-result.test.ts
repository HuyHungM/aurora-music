import { describe, expect, it } from "vitest";
import { emptySearchResult } from "@/lib/domain/search-result";
import type { SearchResult } from "@/lib/domain/search-result";
import type { Track } from "@/lib/domain/track";

function makeTrack(id: string): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: `yt-${id}`,
    title: `Track ${id}`,
    artistId: "artist-1",
    artistName: "Artist",
  };
}

describe("SearchResult", () => {
  it("carries query, sources, and pagination", () => {
    const result: SearchResult<Track> = {
      items: [makeTrack("1"), makeTrack("2")],
      query: "Lạc Trôi",
      sources: ["youtube", "spotify", "deezer"],
      total: 2,
      nextOffset: null,
    };
    expect(result.items).toHaveLength(2);
    expect(result.query).toBe("Lạc Trôi");
    expect(result.sources).toEqual(["youtube", "spotify", "deezer"]);
  });

  it("creates empty results that retain query provenance", () => {
    const result = emptySearchResult<Track>("Lạc Trôi", ["youtube"]);
    expect(result.items).toEqual([]);
    expect(result.query).toBe("Lạc Trôi");
    expect(result.sources).toEqual(["youtube"]);
  });

  it("supports partial provider failure via recorded sources", () => {
    const result: SearchResult<Track> = {
      items: [makeTrack("1")],
      query: "Lạc Trôi",
      sources: ["youtube"],
    };
    expect(result.sources).not.toContain("spotify");
    expect(result.items).toHaveLength(1);
  });
});
