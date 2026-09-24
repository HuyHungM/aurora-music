import { beforeEach, describe, expect, it } from "vitest";
import type { Track } from "@/lib/domain";
import { normalizeList, resolveList } from "@/lib/providers";
import type { ProviderListResult, ProviderTrackDTO } from "@/lib/providers";
import { ProviderNotFoundError } from "@/lib/errors";
import { clearProviders, getProvider, registerProvider } from "@/lib/providers";
import type { MusicProvider } from "@/lib/providers";

const dto: ProviderTrackDTO = {
  id: "t1",
  title: "Interstellar",
  artistId: "a1",
  artistName: "Aurora",
};

const toDomain = (source: ProviderTrackDTO): Track => ({
  id: source.id,
  provider: "test-provider",
  title: source.title,
  artistId: source.artistId,
  artistName: source.artistName,
});

describe("normalizeList", () => {
  it("maps provider DTOs into domain models", () => {
    expect(normalizeList([dto], toDomain)).toEqual([
      { id: "t1", provider: "test-provider", title: "Interstellar", artistId: "a1", artistName: "Aurora" },
    ]);
  });

  it("maps an empty list to an empty list", () => {
    expect(normalizeList([], toDomain)).toEqual([]);
  });
});

describe("resolveList", () => {
  it("normalizes items while preserving pagination metadata", () => {
    const result: ProviderListResult<ProviderTrackDTO> = {
      items: [dto],
      total: 1,
      nextOffset: 1,
    };
    const resolved = resolveList(result, toDomain);
    expect(resolved).toEqual({
      items: [{ id: "t1", provider: "test-provider", title: "Interstellar", artistId: "a1", artistName: "Aurora" }],
      total: 1,
      nextOffset: 1,
    });
    expect(resolved.items[0].provider).toBe("test-provider");
  });
});

const makeDummyProvider = (): MusicProvider => ({
  id: "test-provider",
  name: "Test Provider",
  capabilities: new Set([
    "search.tracks",
    "search.artists",
    "search.albums",
    "tracks.get",
    "tracks.popular",
    "tracks.featured",
    "tracks.recommendations",
    "albums.get",
    "albums.tracks",
    "artists.get",
    "artists.tracks",
    "stream",
  ]),
  searchTracks: async () => ({ items: [] }),
  searchArtists: async () => ({ items: [] }),
  searchAlbums: async () => ({ items: [] }),
  getTrack: async () => ({ ...toDomain(dto) }),
  getArtist: async () => ({ id: "a1", provider: "test-provider", name: "Aurora" }),
  getAlbum: async () => ({
    id: "al1",
    provider: "test-provider",
    title: "The Gods We Can Touch",
    artistId: "a1",
    artistName: "Aurora",
  }),
  getAlbumTracks: async () => ({ items: [] }),
  getArtistTracks: async () => ({ items: [] }),
  getPopularTracks: async () => ({ items: [] }),
  getFeaturedTracks: async () => ({ items: [] }),
  getRecommendations: async () => ({ items: [] }),
  getStreamUrl: async () => "https://example.invalid/stream",
});

describe("provider registry", () => {
  beforeEach(() => {
    clearProviders();
  });

  it("throws ProviderNotFoundError for unregistered providers", () => {
    expect(() => getProvider("test-provider")).toThrow(ProviderNotFoundError);
  });

  it("returns a registered provider", () => {
    const provider = makeDummyProvider();
    registerProvider(provider);
    expect(getProvider("test-provider")).toBe(provider);
  });
});
