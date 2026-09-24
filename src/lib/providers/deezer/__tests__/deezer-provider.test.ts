import { describe, expect, it, vi } from "vitest";
import {
  ExtractorError,
  NormalizationError,
  TrackNotFoundError,
} from "@/lib/domain";
import { UnsupportedProviderCapabilityError } from "@/lib/errors";
import { asExtractor } from "@/lib/providers/extractor";
import { createDeezerProvider } from "@/lib/providers/deezer/deezer-provider";
import type { DeezerApiTransport } from "@/lib/providers/deezer/types";

const ARTIST = { id: 27, name: "Daft Punk", picture_big: "https://pics/p-b.jpg" };
const ALBUM = {
  id: 302127,
  title: "Discovery",
  cover_big: "https://pics/c-b.jpg",
  release_date: "2001-03-07",
  artist: ARTIST,
};

function trackObject(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Song ${id}`,
    link: `https://www.deezer.com/track/${id}`,
    duration: 200,
    explicit_lyrics: false,
    preview: `https://cdns-preview/${id}.mp3`,
    readable: true,
    artist: ARTIST,
    album: ALBUM,
    ...overrides,
  };
}

function makeTransport(
  overrides: Partial<DeezerApiTransport> = {},
): DeezerApiTransport {
  const trackNotFound = async (): Promise<never> => {
    throw new TrackNotFoundError({ provider: "deezer", providerTrackId: "0" });
  };
  const missing = (operation: string) => async (): Promise<never> => {
    throw new ExtractorError("deezer", operation, "Not found");
  };
  return {
    searchTracks: async () => ({ data: [], total: 0 }),
    searchArtists: async () => ({ data: [], total: 0 }),
    searchAlbums: async () => ({ data: [], total: 0 }),
    getTrack: trackNotFound,
    getArtist: missing("getArtist"),
    getArtistTopTracks: async () => ({ data: [], total: 0 }),
    getAlbum: missing("getAlbum"),
    getAlbumTracks: async () => ({ data: [], total: 0 }),
    getPlaylist: missing("getPlaylist"),
    getPlaylistTracks: async () => ({ data: [], total: 0 }),
    getChartTracks: async () => ({ data: [], total: 0 }),
    ...overrides,
  };
}

describe("Deezer provider identity", () => {
  it("uses the canonical deezer id and adapts to Extractor", () => {
    const provider = createDeezerProvider(makeTransport());
    expect(provider.id).toBe("deezer");
    expect(provider.isMock).toBeUndefined();
    expect(asExtractor(provider).name).toBe("deezer");
    expect(
      asExtractor(provider).validate("https://www.deezer.com/track/3135556"),
    ).toBe(true);
  });

  it("advertises metadata capabilities without stream", () => {
    const provider = createDeezerProvider(makeTransport());
    for (const cap of [
      "search.tracks",
      "tracks.get",
      "search.artists",
      "artists.get",
      "artists.tracks",
      "search.albums",
      "albums.get",
      "albums.tracks",
      "tracks.popular",
    ] as const) {
      expect(provider.capabilities.has(cap)).toBe(true);
    }
    expect(provider.capabilities.has("tracks.featured")).toBe(false);
    expect(provider.capabilities.has("tracks.recommendations")).toBe(false);
    expect(provider.capabilities.has("stream")).toBe(false);
  });

  it("rejects stream, featured, and recommendations explicitly", async () => {
    const provider = createDeezerProvider(makeTransport());
    await expect(provider.getStreamUrl("1")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getFeaturedTracks()).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getRecommendations("1")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
  });
});

describe("Deezer track search", () => {
  it("returns normalized tracks with pagination", async () => {
    const provider = createDeezerProvider(
      makeTransport({
        searchTracks: async () => ({
          data: [trackObject(1), trackObject(2)],
          total: 10,
        }),
      }),
    );
    const result = await provider.searchTracks({ query: "Daft", limit: 2, offset: 0 });
    expect(result.items.map((track) => track.providerTrackId)).toEqual(["1", "2"]);
    expect(result.total).toBe(10);
    expect(result.nextOffset).toBe(2);
  });

  it("returns empty results for valid queries with no hits", async () => {
    const provider = createDeezerProvider(makeTransport());
    const result = await provider.searchTracks({ query: "zzz-no-match" });
    expect(result.items).toEqual([]);
    expect(result.nextOffset).toBeNull();
  });

  it("skips malformed and unreadable items without failing", async () => {
    const provider = createDeezerProvider(
      makeTransport({
        searchTracks: async () => ({
          data: [null, { nope: true }, trackObject(1), trackObject(2, { readable: false })],
          total: 4,
        }),
      }),
    );
    const result = await provider.searchTracks({ query: "x" });
    expect(result.items).toHaveLength(1);
  });

  it("rejects blank queries before any remote call", async () => {
    const searchTracks = vi.fn(async () => ({ data: [], total: 0 }));
    const provider = createDeezerProvider(makeTransport({ searchTracks }));
    await expect(provider.searchTracks({ query: "  " })).rejects.toBeInstanceOf(
      NormalizationError,
    );
    expect(searchTracks).not.toHaveBeenCalled();
  });

  it("propagates upstream failures typed", async () => {
    const provider = createDeezerProvider(
      makeTransport({
        searchTracks: async () => {
          throw new ExtractorError("deezer", "search", "quota exceeded");
        },
      }),
    );
    await expect(provider.searchTracks({ query: "x" })).rejects.toMatchObject({
      code: "EXTRACTOR_ERROR",
    });
  });
});

describe("Deezer track lookup", () => {
  it("returns the exact track with Deezer metadata", async () => {
    const provider = createDeezerProvider(
      makeTransport({ getTrack: async () => trackObject(3135556) }),
    );
    const track = await provider.getTrack("3135556");
    expect(track).toMatchObject({
      provider: "deezer",
      providerTrackId: "3135556",
      duration: 200,
      explicit: false,
      albumId: "302127",
    });
  });

  it("throws not-found for unknown ids", async () => {
    const provider = createDeezerProvider(makeTransport());
    await expect(provider.getTrack("3135556")).rejects.toBeInstanceOf(
      TrackNotFoundError,
    );
  });

  it("rejects malformed ids before any remote call", async () => {
    const getTrack = vi.fn(async () => trackObject(1));
    const provider = createDeezerProvider(makeTransport({ getTrack }));
    await expect(provider.getTrack("abc")).rejects.toBeInstanceOf(NormalizationError);
    expect(getTrack).not.toHaveBeenCalled();
  });

  it("never substitutes another track", async () => {
    const provider = createDeezerProvider(
      makeTransport({ getTrack: async () => trackObject(999) }),
    );
    await expect(provider.getTrack("3135556")).rejects.toBeInstanceOf(
      TrackNotFoundError,
    );
  });
});

describe("Deezer artist support", () => {
  function artistTransport() {
    return makeTransport({
      searchArtists: async () => ({ data: [ARTIST], total: 1 }),
      getArtist: async () => ARTIST,
      getArtistTopTracks: async () => ({ data: [trackObject(1)], total: 1 }),
    });
  }

  it("searches, resolves, and lists top tracks", async () => {
    const provider = createDeezerProvider(artistTransport());
    const searched = await provider.searchArtists({ query: "Daft" });
    expect(searched.items[0]).toMatchObject({ providerArtistId: "27" });
    await expect(provider.getArtist("27")).resolves.toMatchObject({ id: "27" });
    const top = await provider.getArtistTracks("27", { limit: 5 });
    expect(top.items).toHaveLength(1);
  });

  it("rejects malformed artist ids pre-call", async () => {
    const getArtist = vi.fn(async () => ARTIST);
    const provider = createDeezerProvider(makeTransport({ getArtist }));
    await expect(provider.getArtist("xx")).rejects.toBeInstanceOf(NormalizationError);
    expect(getArtist).not.toHaveBeenCalled();
  });
});

describe("Deezer album support", () => {
  function albumTransport() {
    return makeTransport({
      searchAlbums: async () => ({ data: [ALBUM], total: 1 }),
      getAlbum: async () => ALBUM,
      getAlbumTracks: async () => ({
        data: [trackObject(1), trackObject(2)],
        total: 2,
      }),
    });
  }

  it("searches, resolves, and lists tracks in source order", async () => {
    const provider = createDeezerProvider(albumTransport());
    const searched = await provider.searchAlbums({ query: "Discovery" });
    expect(searched.items[0]).toMatchObject({
      providerAlbumId: "302127",
      releaseDate: "2001-03-07",
    });
    await expect(provider.getAlbum("302127")).resolves.toMatchObject({
      id: "302127",
    });
    const tracks = await provider.getAlbumTracks("302127", { limit: 10 });
    expect(tracks.items.map((track) => track.providerTrackId)).toEqual(["1", "2"]);
    expect(tracks.items[0]?.albumId).toBe("302127");
  });

  it("paginates album tracks with offset", async () => {
    const provider = createDeezerProvider(albumTransport());
    const page = await provider.getAlbumTracks("302127", { limit: 1, offset: 1 });
    expect(page.items.map((track) => track.providerTrackId)).toEqual(["2"]);
  });
});

describe("Deezer popular tracks", () => {
  it("reads the chart without recommendations support", async () => {
    const provider = createDeezerProvider(
      makeTransport({
        getChartTracks: async () => ({ data: [trackObject(7)], total: 100 }),
      }),
    );
    const popular = await provider.getPopularTracks({ limit: 1 });
    expect(popular.items[0]?.providerTrackId).toBe("7");
  });
});

describe("Deezer playlist lookup", () => {
  function playlistTransport() {
    return makeTransport({
      getPlaylist: async () => ({
        id: 908841,
        title: "Mix",
        description: "desc",
        picture_big: "https://pics/pl-b.jpg",
        nb_tracks: 3,
      }),
      getPlaylistTracks: async () => ({
        data: [
          trackObject(1),
          { id: 2, title: "Gone", readable: false },
          trackObject(3),
        ],
        total: 3,
      }),
    });
  }

  it("returns ordered tracks, skipping unreadable items", async () => {
    const provider = createDeezerProvider(playlistTransport());
    const playlist = await provider.getPlaylist("908841");
    expect(playlist.providerPlaylistId).toBe("908841");
    expect(playlist.tracks.map((track) => track.providerTrackId)).toEqual(["1", "3"]);
    expect(playlist.total).toBe(3);
  });

  it("distinguishes empty playlists from failures", async () => {
    const provider = createDeezerProvider(
      makeTransport({
        getPlaylist: async () => ({ id: 5, title: "Empty", nb_tracks: 0 }),
      }),
    );
    const playlist = await provider.getPlaylist("5");
    expect(playlist.tracks).toEqual([]);
  });

  it("throws a typed error for missing playlists", async () => {
    const provider = createDeezerProvider(makeTransport());
    await expect(provider.getPlaylist("5")).rejects.toMatchObject({
      name: "ExtractorError",
    });
  });
});
