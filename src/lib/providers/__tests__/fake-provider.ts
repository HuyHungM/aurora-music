import type { ProviderId, Track } from "@/lib/domain";
import type { MusicProvider, ProviderCapability } from "@/lib/providers/types";

/**
 * Test-only provider factory. These doubles live exclusively in test
 * infrastructure and are never registered in production code.
 */

export interface FakeProviderOptions {
  tracks?: Track[];
  failSearch?: boolean;
  failTrack?: boolean;
  without?: ProviderCapability[];
}

const ALL_CAPS: ProviderCapability[] = [
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
];

export function makeTrack(
  provider: string,
  id: string,
  title = `Track ${id}`,
): Track {
  return {
    id,
    provider,
    providerTrackId: id,
    title,
    artistId: `${provider}-artist-1`,
    artistName: `${provider} artist`,
  };
}

export function makeFakeProvider(
  id: string,
  options: FakeProviderOptions = {},
): MusicProvider {
  const capabilities = new Set<ProviderCapability>(
    ALL_CAPS.filter((cap) => !(options.without ?? []).includes(cap)),
  );
  const tracks = options.tracks ?? [makeTrack(id, `${id}-t1`)];
  return {
    id: id as ProviderId,
    name: id,
    capabilities,
    searchTracks: async () => {
      if (options.failSearch) {
        throw new Error(`${id} search boom`);
      }
      return { items: tracks, total: tracks.length };
    },
    searchArtists: async () => ({ items: [] }),
    searchAlbums: async () => ({ items: [] }),
    getTrack: async (trackId: string) => {
      if (options.failTrack) {
        throw new Error(`${id} track boom`);
      }
      const found = tracks.find((track) => track.id === trackId);
      if (!found) {
        const { TrackNotFoundError } = await import("@/lib/domain");
        throw new TrackNotFoundError({
          provider: id,
          providerTrackId: trackId,
        });
      }
      return found;
    },
    getArtist: async (artistId: string) => ({
      id: artistId,
      provider: id as ProviderId,
      providerArtistId: artistId,
      name: `Artist ${artistId}`,
    }),
    getAlbum: async (albumId: string) => ({
      id: albumId,
      provider: id as ProviderId,
      providerAlbumId: albumId,
      title: `Album ${albumId}`,
      artistId: `${id}-artist-1`,
      artistName: `${id} artist`,
    }),
    getAlbumTracks: async () => ({ items: [] }),
    getArtistTracks: async () => ({ items: [] }),
    getPopularTracks: async () => ({ items: [] }),
    getFeaturedTracks: async () => ({ items: [] }),
    getRecommendations: async () => ({ items: [] }),
    getStreamUrl: async (trackId: string) => `https://stream/${id}/${trackId}.mp3`,
  };
}
