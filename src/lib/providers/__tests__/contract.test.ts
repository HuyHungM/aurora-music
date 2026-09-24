import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  MusicProvider,
  ProviderCapability,
  ProviderListResult,
} from "@/lib/providers/types";
import type { Album, Artist, Track } from "@/lib/domain";
import { UnsupportedProviderCapabilityError } from "@/lib/errors";
import { clearProviders, registerProvider } from "@/lib/providers/registry";

/**
 * Minimal inline provider used to verify the MusicProvider contract.
 * Concrete providers (YouTube/Deezer/Spotify) will be tested against
 * the same contract once implemented.
 */
function createTestProvider(
  overrides: Partial<MusicProvider> = {},
): MusicProvider {
  const empty = async <T>(): Promise<ProviderListResult<T>> => ({
    items: [],
    total: 0,
    nextOffset: null,
  });
  const missing = async (what: string): Promise<never> => {
    throw new UnsupportedProviderCapabilityError(
      "test-provider",
      what,
      `${what} is not supported by the test provider`,
    );
  };
  return {
    id: "test-provider",
    name: "Test Provider",
    capabilities: new Set<ProviderCapability>([
      "search.tracks",
      "search.artists",
      "search.albums",
      "tracks.get",
      "tracks.popular",
      "tracks.featured",
      "artists.get",
      "artists.tracks",
      "stream",
    ]),
    searchTracks: async () => empty<Track>(),
    searchArtists: async () => empty<Artist>(),
    searchAlbums: async () => empty<Album>(),
    getTrack: async (id: string): Promise<Track> => ({
      id,
      provider: "test-provider",
      providerTrackId: id,
      title: `Track ${id}`,
      artistId: "a1",
      artistName: "Test Artist",
    }),
    getArtist: async (id: string): Promise<Artist> => ({
      id,
      provider: "test-provider",
      providerArtistId: id,
      name: `Artist ${id}`,
    }),
    getAlbum: async (): Promise<Album> => missing("albums.get"),
    getAlbumTracks: async (): Promise<ProviderListResult<Track>> =>
      missing("albums.tracks"),
    getArtistTracks: async (): Promise<ProviderListResult<Track>> =>
      empty<Track>(),
    getPopularTracks: async (): Promise<ProviderListResult<Track>> =>
      empty<Track>(),
    getFeaturedTracks: async (): Promise<ProviderListResult<Track>> =>
      empty<Track>(),
    getRecommendations: async (): Promise<ProviderListResult<Track>> =>
      missing("tracks.recommendations"),
    getStreamUrl: async (id: string): Promise<string> =>
      `https://stream.example/${id}.mp3`,
    ...overrides,
  };
}

describe("Provider Contract", () => {
  let provider: MusicProvider;

  beforeEach(() => {
    clearProviders();
    provider = createTestProvider();
    registerProvider(provider);
  });

  afterEach(() => {
    clearProviders();
  });

  describe("capabilities", () => {
    it("exposes a capabilities set", () => {
      expect(provider.capabilities).toBeInstanceOf(Set);
      expect(provider.capabilities.size).toBeGreaterThan(0);
    });

    it("advertises only truthful capabilities", () => {
      expect(provider.capabilities.has("search.tracks")).toBe(true);
      expect(provider.capabilities.has("tracks.get")).toBe(true);
      expect(provider.capabilities.has("stream")).toBe(true);
      expect(provider.capabilities.has("tracks.recommendations")).toBe(false);
      expect(provider.capabilities.has("albums.get")).toBe(false);
      expect(provider.capabilities.has("albums.tracks")).toBe(false);
    });
  });

  describe("searchTracks", () => {
    it("returns a list result", async () => {
      const result = await provider.searchTracks({ query: "test" });
      expect(result.items).toBeInstanceOf(Array);
    });
  });

  describe("searchArtists", () => {
    it("returns a list result", async () => {
      const result = await provider.searchArtists({ query: "test" });
      expect(result.items).toBeInstanceOf(Array);
    });
  });

  describe("searchAlbums", () => {
    it("returns a list result", async () => {
      const result = await provider.searchAlbums({ query: "test" });
      expect(result.items).toBeInstanceOf(Array);
    });
  });

  describe("getTrack", () => {
    it("returns a normalized track", async () => {
      const track = await provider.getTrack("t1");
      expect(track).toMatchObject({
        id: expect.any(String),
        provider: expect.any(String),
        providerTrackId: expect.any(String),
        title: expect.any(String),
        artistId: expect.any(String),
        artistName: expect.any(String),
      });
    });
  });

  describe("getArtist", () => {
    it("returns a normalized artist", async () => {
      const artist = await provider.getArtist("a1");
      expect(artist).toMatchObject({
        id: expect.any(String),
        provider: expect.any(String),
        providerArtistId: expect.any(String),
        name: expect.any(String),
      });
    });
  });

  describe("getAlbum", () => {
    it("throws UnsupportedProviderCapabilityError when unsupported", async () => {
      await expect(provider.getAlbum("al1")).rejects.toThrow(
        UnsupportedProviderCapabilityError,
      );
    });
  });

  describe("getAlbumTracks", () => {
    it("throws UnsupportedProviderCapabilityError when unsupported", async () => {
      await expect(provider.getAlbumTracks("al1")).rejects.toThrow(
        UnsupportedProviderCapabilityError,
      );
    });
  });

  describe("getArtistTracks", () => {
    it("returns a list result", async () => {
      const result = await provider.getArtistTracks("a1");
      expect(result.items).toBeInstanceOf(Array);
    });
  });

  describe("getPopularTracks", () => {
    it("returns a list result", async () => {
      const result = await provider.getPopularTracks();
      expect(result.items).toBeInstanceOf(Array);
    });
  });

  describe("getFeaturedTracks", () => {
    it("returns a list result", async () => {
      const result = await provider.getFeaturedTracks();
      expect(result.items).toBeInstanceOf(Array);
    });
  });

  describe("getRecommendations", () => {
    it("throws UnsupportedProviderCapabilityError when unsupported", async () => {
      await expect(provider.getRecommendations("t1")).rejects.toThrow(
        UnsupportedProviderCapabilityError,
      );
    });
  });

  describe("getStreamUrl", () => {
    it("returns a stream URL string", async () => {
      const url = await provider.getStreamUrl("t1");
      expect(typeof url).toBe("string");
      expect(url.length).toBeGreaterThan(0);
    });
  });
});
