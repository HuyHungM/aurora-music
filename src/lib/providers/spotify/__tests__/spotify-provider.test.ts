import { describe, expect, it, vi } from "vitest";
import {
  ExtractorError,
  NormalizationError,
  TrackNotFoundError,
} from "@/lib/domain";
import { UnsupportedProviderCapabilityError } from "@/lib/errors";
import { asExtractor } from "@/lib/providers/extractor";
import { createSpotifyProvider } from "@/lib/providers/spotify/spotify-provider";
import type { SpotifyApiTransport } from "@/lib/providers/spotify/types";

const TRACK_ID = "4uLU6hMCjMI75M1A2tKUQ3";
const ARTIST_ID = "0OdUWJ0sBjDrqHygGUXeCF";
const ALBUM_ID = "1DFixLWuPkv3KT3TnV35i3";

function trackObject(id: string, name = `Song ${id}`) {
  return {
    id,
    type: "track",
    name,
    duration_ms: 200_000,
    explicit: false,
    artists: [{ id: ARTIST_ID, name: "Artist" }],
    album: {
      id: ALBUM_ID,
      name: "Album",
      images: [{ url: "https://img/300.jpg", width: 300 }],
      artists: [{ id: ARTIST_ID, name: "Artist" }],
    },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  };
}

function makeTransport(
  overrides: Partial<SpotifyApiTransport> = {},
): SpotifyApiTransport {
  const notFound = async (): Promise<never> => {
    throw new TrackNotFoundError({ provider: "spotify", providerTrackId: "x" });
  };
  const missing = (operation: string) => async (): Promise<never> => {
    throw new ExtractorError("spotify", operation, "Not found");
  };
  return {
    search: async () => ({}),
    getTrack: notFound,
    getArtist: missing("getArtist"),
    getArtistAlbums: async () => ({ items: [], total: 0 }),
    getAlbum: missing("getAlbum"),
    getAlbumTracks: async () => ({ items: [], total: 0 }),
    getPlaylist: missing("getPlaylist"),
    getPlaylistItems: async () => ({ items: [], total: 0 }),
    ...overrides,
  };
}

describe("Spotify provider identity", () => {
  it("uses the canonical spotify id and adapts to Extractor", () => {
    const provider = createSpotifyProvider(makeTransport());
    expect(provider.id).toBe("spotify");
    expect(provider.isMock).toBeUndefined();
    expect(asExtractor(provider).name).toBe("spotify");
    expect(
      asExtractor(provider).validate(
        `https://open.spotify.com/track/${TRACK_ID}`,
      ),
    ).toBe(true);
  });

  it("advertises catalog capabilities without stream or artist-tracks", () => {
    const provider = createSpotifyProvider(makeTransport());
    for (const cap of [
      "search.tracks",
      "tracks.get",
      "search.artists",
      "artists.get",
      "search.albums",
      "albums.get",
      "albums.tracks",
    ] as const) {
      expect(provider.capabilities.has(cap)).toBe(true);
    }
    expect(provider.capabilities.has("artists.tracks")).toBe(false);
    expect(provider.capabilities.has("tracks.popular")).toBe(false);
    expect(provider.capabilities.has("tracks.featured")).toBe(false);
    expect(provider.capabilities.has("tracks.recommendations")).toBe(false);
    expect(provider.capabilities.has("stream")).toBe(false);
  });

  it("rejects stream, artist-tracks, popular, featured explicitly", async () => {
    const provider = createSpotifyProvider(makeTransport());
    await expect(provider.getStreamUrl("x")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getArtistTracks("x")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getPopularTracks()).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getFeaturedTracks()).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
    await expect(provider.getRecommendations("x")).rejects.toBeInstanceOf(
      UnsupportedProviderCapabilityError,
    );
  });
});

describe("Spotify search", () => {
  it("searches tracks within one request under the limit", async () => {
    const search = vi.fn<SpotifyApiTransport["search"]>(async () => ({
      tracks: { items: [trackObject("t1")], total: 1 },
    }));
    const provider = createSpotifyProvider(makeTransport({ search }));
    const result = await provider.searchTracks({ query: "Lạc Trôi", limit: 5 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[1]).toEqual(["track"]);
    expect(search.mock.calls[0]?.[2]).toMatchObject({ limit: 5, offset: 0 });
  });

  it("paginates boundedly when Aurora asks for more than one API page", async () => {
    const search = vi.fn(
      async (
        _q: string,
        _t: string[],
        paging?: { limit?: number; offset?: number },
      ) => {
        const pageSize = paging?.limit ?? 50;
        const start = paging?.offset ?? 0;
        return {
          tracks: {
            items: Array.from(
              { length: pageSize },
              (_, index) => trackObject(`t${start + index}`),
            ),
            total: 100,
          },
        };
      },
    );
    const provider = createSpotifyProvider(makeTransport({ search }));
    // More than the 50 the search API returns in one call, so the bounded
    // page walk is still exercised.
    const result = await provider.searchTracks({ query: "x", limit: 75 });
    expect(result.items).toHaveLength(75);
    expect(result.items[0]?.providerTrackId).toBe("t0");
    expect(result.items[74]?.providerTrackId).toBe("t74");
    expect(search).toHaveBeenCalledTimes(2);
    for (const call of search.mock.calls) {
      expect((call[2] as { limit: number }).limit).toBeLessThanOrEqual(50);
    }
  });

  it("answers the product's own largest search ask in one request", async () => {
    // `SEARCH_PAGE_SIZE` is the API's 50 cap rather than a conservative 10,
    // so the 20-result search the search page actually performs costs one
    // round trip instead of two. This is a quota/request-count contract, not
    // a performance nicety: the search page runs three type-scoped searches
    // per render, so the old page size cost six requests instead of three.
    const search = vi.fn(
      async (
        _q: string,
        _t: string[],
        paging?: { limit?: number; offset?: number },
      ) => {
        const pageSize = paging?.limit ?? 50;
        const start = paging?.offset ?? 0;
        return {
          tracks: {
            items: Array.from(
              { length: pageSize },
              (_, index) => trackObject(`t${start + index}`),
            ),
            total: 100,
          },
        };
      },
    );
    const provider = createSpotifyProvider(makeTransport({ search }));
    const result = await provider.searchTracks({ query: "x", limit: 20 });
    expect(result.items).toHaveLength(20);
    expect(result.items[19]?.providerTrackId).toBe("t19");
    expect(search).toHaveBeenCalledTimes(1);
    expect((search.mock.calls[0]?.[2] as { limit: number }).limit).toBe(20);
  });

  it("returns empty results for valid queries with no hits", async () => {
    const provider = createSpotifyProvider(makeTransport());
    const result = await provider.searchTracks({ query: "zzz-no-match" });
    expect(result.items).toEqual([]);
  });

  it("rejects blank queries before any remote call", async () => {
    const search = vi.fn(async () => ({}));
    const provider = createSpotifyProvider(makeTransport({ search }));
    await expect(provider.searchTracks({ query: "  " })).rejects.toBeInstanceOf(
      NormalizationError,
    );
    expect(search).not.toHaveBeenCalled();
  });

  it("searches artists and albums", async () => {
    const provider = createSpotifyProvider(
      makeTransport({
        search: async (_q, types) => {
          if (types.includes("artist")) {
            return { artists: { items: [{ id: ARTIST_ID, name: "A" }], total: 1 } };
          }
          return {
            albums: {
              items: [{ id: ALBUM_ID, name: "Al", artists: [{ id: ARTIST_ID, name: "A" }] }],
              total: 1,
            },
          };
        },
      }),
    );
    await expect(provider.searchArtists({ query: "A" })).resolves.toMatchObject({
      items: [{ providerArtistId: ARTIST_ID }],
    });
    await expect(provider.searchAlbums({ query: "Al" })).resolves.toMatchObject({
      items: [{ providerAlbumId: ALBUM_ID }],
    });
  });
});

describe("Spotify track lookup", () => {
  it("returns the exact track", async () => {
    const provider = createSpotifyProvider(
      makeTransport({ getTrack: async () => trackObject(TRACK_ID, "Lạc Trôi") }),
    );
    const track = await provider.getTrack(TRACK_ID);
    expect(track).toMatchObject({
      provider: "spotify",
      providerTrackId: TRACK_ID,
      title: "Lạc Trôi",
      duration: 200,
    });
  });

  it("throws not-found for unknown ids", async () => {
    const provider = createSpotifyProvider(makeTransport());
    await expect(provider.getTrack(TRACK_ID)).rejects.toBeInstanceOf(
      TrackNotFoundError,
    );
  });

  it("rejects malformed ids before any remote call", async () => {
    const getTrack = vi.fn(async () => trackObject(TRACK_ID));
    const provider = createSpotifyProvider(makeTransport({ getTrack }));
    await expect(provider.getTrack("not an id!!")).rejects.toBeInstanceOf(
      NormalizationError,
    );
    expect(getTrack).not.toHaveBeenCalled();
  });

  it("never substitutes another track", async () => {
    const provider = createSpotifyProvider(
      makeTransport({ getTrack: async () => trackObject("other00000000000000001") }),
    );
    await expect(provider.getTrack(TRACK_ID)).rejects.toBeInstanceOf(
      TrackNotFoundError,
    );
  });
});

describe("Spotify artist support", () => {
  it("resolves artists and lists their albums", async () => {
    const provider = createSpotifyProvider(
      makeTransport({
        getArtist: async () => ({ id: ARTIST_ID, name: "A" }),
        getArtistAlbums: async () => ({
          items: [{ id: ALBUM_ID, name: "Al", artists: [{ id: ARTIST_ID, name: "A" }] }],
          total: 1,
        }),
      }),
    );
    await expect(provider.getArtist(ARTIST_ID)).resolves.toMatchObject({
      id: ARTIST_ID,
    });
    const albums = await provider.getArtistAlbums(ARTIST_ID, { limit: 10 });
    expect(albums.items[0]?.providerAlbumId).toBe(ALBUM_ID);
  });
});

describe("Spotify album support", () => {
  it("resolves albums and lists tracks in order", async () => {
    const provider = createSpotifyProvider(
      makeTransport({
        getAlbum: async () => ({
          id: ALBUM_ID,
          name: "Al",
          release_date: "2020",
          artists: [{ id: ARTIST_ID, name: "A" }],
        }),
        getAlbumTracks: async () => ({
          items: [
            { ...trackObject("t1"), disc_number: 1, track_number: 1 },
            { ...trackObject("t2"), disc_number: 1, track_number: 2 },
          ],
          total: 2,
        }),
      }),
    );
    await expect(provider.getAlbum(ALBUM_ID)).resolves.toMatchObject({
      releaseDate: "2020",
    });
    const tracks = await provider.getAlbumTracks(ALBUM_ID, { limit: 10 });
    expect(tracks.items.map((track) => track.providerTrackId)).toEqual(["t1", "t2"]);
    expect(tracks.items[0]?.albumId).toBe(ALBUM_ID);
    expect(tracks.items[0]?.metadata).toMatchObject({ trackNumber: 1 });
  });
});

describe("Spotify playlist support", () => {
  function playlistTransport() {
    return makeTransport({
      getPlaylist: async () => ({
        id: "pl1",
        name: "Mix",
        description: "desc",
        images: [{ url: "https://img/p.jpg", width: 300 }],
        owner: { id: "owner1" },
        tracks: { total: 3 },
        external_urls: { spotify: "https://open.spotify.com/playlist/pl1" },
      }),
      getPlaylistItems: async () => ({
        items: [
          { track: trackObject("t1") },
          { track: null },
          { track: { ...trackObject("t2"), type: "episode" } },
          { track: trackObject("t3") },
        ],
        total: 4,
      }),
    });
  }

  it("returns metadata with ordered tracks, skipping removed/episodes", async () => {
    const provider = createSpotifyProvider(playlistTransport());
    const playlist = await provider.getPlaylist("pl1");
    expect(playlist.title).toBe("Mix");
    expect(playlist.ownerId).toBe("owner1");
    expect(playlist.tracks.map((track) => track.providerTrackId)).toEqual([
      "t1",
      "t3",
    ]);
    expect(playlist.total).toBe(3);
  });

  it("distinguishes empty playlists from failures", async () => {
    const provider = createSpotifyProvider(
      makeTransport({
        getPlaylist: async () => ({ id: "pl2", name: "Empty", tracks: { total: 0 } }),
      }),
    );
    const playlist = await provider.getPlaylist("pl2");
    expect(playlist.tracks).toEqual([]);
  });

  it("surfaces forbidden item access as failure, never empty", async () => {
    const provider = createSpotifyProvider(
      makeTransport({
        getPlaylist: async () => ({ id: "pl3", name: "Private", tracks: { total: 5 } }),
        getPlaylistItems: async () => {
          throw new ExtractorError("spotify", "getPlaylistItems", "Spotify forbids this request");
        },
      }),
    );
    await expect(provider.getPlaylist("pl3")).rejects.toMatchObject({
      name: "ExtractorError",
    });
  });
});
