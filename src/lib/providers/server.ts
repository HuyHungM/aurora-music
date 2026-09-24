import { getEnv } from "@/lib/config/env";
import { listProviders } from "@/lib/providers/registry";
import type { MusicProvider, ProviderCapability } from "@/lib/providers/types";
import type { Album, Artist, Track } from "@/lib/domain";
import type { EnvConfig } from "@/lib/config/env";
import { ProviderNotFoundError } from "@/lib/errors";
import { ensureYouTubeProvider } from "@/lib/providers/youtube/bootstrap";
import { ensureDeezerProvider } from "@/lib/providers/deezer/bootstrap";
import { ensureSpotifyProvider } from "@/lib/providers/spotify/bootstrap";

export function getShellProviders(env: EnvConfig = getEnv()): MusicProvider[] {
  // Registers the YouTube provider when a server-side key is configured.
  // No key = no registration = no behavior change (tests, local dev).
  ensureYouTubeProvider(env);
  // Deezer catalog endpoints need no credentials: always registered.
  ensureDeezerProvider();
  // Spotify needs Client Credentials; absent = stays unregistered.
  ensureSpotifyProvider(env);
  return listProviders();
}

export function getPreferredProvider(env: EnvConfig = getEnv()): MusicProvider {
  const providers = getShellProviders(env);
  const preferred =
    providers.find((provider) => !provider.isMock) ?? providers[0];
  if (!preferred) {
    throw new ProviderNotFoundError("none-registered");
  }
  return preferred;
}

// ---------------------------------------------------------------------------
// Capability result types
// ---------------------------------------------------------------------------

export type CapabilityResultKind = "success" | "unsupported" | "failed";

export interface CapabilitySuccess<T> {
  kind: "success";
  data: T;
}

export interface CapabilityUnsupported {
  kind: "unsupported";
}

export interface CapabilityFailed {
  kind: "failed";
}

export type CapabilityResult<T> = CapabilitySuccess<T> | CapabilityUnsupported | CapabilityFailed;

function ok<T>(data: T): CapabilitySuccess<T> {
  return { kind: "success", data };
}

export const unsupported: CapabilityUnsupported = { kind: "unsupported" };
export const failed: CapabilityFailed = { kind: "failed" };

async function safeFetch<T>(
  provider: MusicProvider,
  capability: ProviderCapability,
  fetcher: () => Promise<T>,
): Promise<CapabilityResult<T>> {
  if (!provider.capabilities.has(capability)) {
    return unsupported;
  }
  try {
    return ok(await fetcher());
  } catch {
    return failed;
  }
}

function findRecommendationSeed(
  recent: Track[],
  liked: Track[],
  popular: Track[],
): string | null {
  const candidates = [...recent, ...liked, ...popular];
  for (const track of candidates) {
    if (track.providerTrackId) {
      return track.providerTrackId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Home sections
// ---------------------------------------------------------------------------

export type SectionStatus = "success" | "unsupported" | "failed";

export interface HomeSections {
  popular: Track[];
  featured: Track[];
  featuredAlbums: Album[];
  featuredArtists: Artist[];
  recommendations: Track[];
  popularStatus: SectionStatus;
  featuredStatus: SectionStatus;
  recommendationsStatus: SectionStatus;
}

export async function fetchHomeSections(
  recentTracks: Track[] = [],
  likedTracks: Track[] = [],
  env: EnvConfig = getEnv(),
): Promise<HomeSections> {
  const provider = getPreferredProvider(env);

  const hasPopular = provider.capabilities.has("tracks.popular");
  const hasFeatured = provider.capabilities.has("tracks.featured");
  const hasRecommendations = provider.capabilities.has("tracks.recommendations");
  const hasAlbumsGet = provider.capabilities.has("albums.get");
  const hasArtistsGet = provider.capabilities.has("artists.get");

  const [
    popularResult,
    featuredResult,
    recommendationsResult,
  ] = await Promise.allSettled([
    hasPopular
      ? safeFetch(provider, "tracks.popular", () =>
          provider.getPopularTracks({ limit: 12 }),
        )
      : Promise.resolve(unsupported),
    hasFeatured
      ? safeFetch(provider, "tracks.featured", () =>
          provider.getFeaturedTracks({ limit: 12 }),
        )
      : Promise.resolve(unsupported),
    (async () => {
      if (!hasRecommendations) return unsupported;
      const seedTrackId = findRecommendationSeed(recentTracks, likedTracks, []);
      if (!seedTrackId) return ok({ items: [] as Track[], total: 0 });
      return safeFetch(provider, "tracks.recommendations", () =>
        provider.getRecommendations(seedTrackId, { limit: 10 }),
      );
    })(),
  ]);

  const extractItems = (
    result: PromiseSettledResult<CapabilityResult<{ items: Track[] }>>,
  ): Track[] => {
    if (result.status !== "fulfilled") return [];
    const r = result.value;
    if (r.kind !== "success") return [];
    return r.data.items;
  };

  const extractStatus = (
    result: PromiseSettledResult<CapabilityResult<{ items: Track[] }>>,
  ): SectionStatus => {
    if (result.status !== "fulfilled") return "failed";
    const r = result.value;
    if (r.kind === "unsupported") return "unsupported";
    if (r.kind === "failed") return "failed";
    return "success";
  };

  const popularItems = extractItems(popularResult);
  const featuredItems = extractItems(featuredResult);

  const [featuredAlbumsResult, featuredArtistsResult] = await Promise.allSettled([
    (async () => {
      if (!hasAlbumsGet) return [];
      const albumIds = new Set<string>();
      const albums: Album[] = [];
      for (const track of popularItems) {
        if (track.albumId && !albumIds.has(track.albumId)) {
          albumIds.add(track.albumId);
          try {
            const result = await safeFetch(provider, "albums.get", () =>
              provider.getAlbum(track.albumId!),
            );
            if (result.kind === "success") albums.push(result.data);
          } catch {
            // skip
          }
        }
      }
      return albums;
    })(),
    (async () => {
      if (!hasArtistsGet) return [];
      const artistIds = new Set<string>();
      const artists: Artist[] = [];
      for (const track of popularItems) {
        if (track.artistId && !artistIds.has(track.artistId)) {
          artistIds.add(track.artistId);
          try {
            const result = await safeFetch(provider, "artists.get", () =>
              provider.getArtist(track.artistId!),
            );
            if (result.kind === "success") artists.push(result.data);
          } catch {
            // skip
          }
        }
      }
      return artists;
    })(),
  ]);

  const extractArray = <T>(result: PromiseSettledResult<T[]>): T[] => {
    if (result.status !== "fulfilled") return [];
    return result.value;
  };

  const recommendationItems = extractItems(recommendationsResult);

  return {
    popular: popularItems,
    featured: featuredItems,
    featuredAlbums: extractArray(featuredAlbumsResult),
    featuredArtists: extractArray(featuredArtistsResult),
    recommendations: recommendationItems,
    popularStatus: extractStatus(popularResult),
    featuredStatus: extractStatus(featuredResult),
    recommendationsStatus: extractStatus(recommendationsResult),
  };
}

export async function fetchHomeSection(
  loader: (provider: MusicProvider) => Promise<Track[]>,
  env: EnvConfig = getEnv(),
): Promise<Track[]> {
  const preferred = getPreferredProvider(env);
  try {
    return await loader(preferred);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Entity detail helpers
// ---------------------------------------------------------------------------

export async function fetchArtistDetail(
  id: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Artist>> {
  const p = provider ?? (env !== undefined ? getPreferredProvider(env) : getPreferredProvider());
  return safeFetch(p, "artists.get", () => p.getArtist(id));
}

export async function fetchAlbumDetail(
  id: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Album>> {
  const p = provider ?? (env !== undefined ? getPreferredProvider(env) : getPreferredProvider());
  return safeFetch(p, "albums.get", () => p.getAlbum(id));
}

export async function fetchTrackDetail(
  id: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Track>> {
  const p = provider ?? (env !== undefined ? getPreferredProvider(env) : getPreferredProvider());
  return safeFetch(p, "tracks.get", () => p.getTrack(id));
}

export async function fetchArtistTracks(
  artistId: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Track[]>> {
  const p = provider ?? (env !== undefined ? getPreferredProvider(env) : getPreferredProvider());
  const result = await safeFetch(p, "artists.tracks", () =>
    p.getArtistTracks(artistId, { limit: 50 }),
  );
  if (result.kind !== "success") return result;
  return ok(result.data.items);
}

export async function fetchAlbumTracks(
  albumId: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Track[]>> {
  const p = provider ?? (env !== undefined ? getPreferredProvider(env) : getPreferredProvider());
  const result = await safeFetch(p, "albums.tracks", () =>
    p.getAlbumTracks(albumId, { limit: 50 }),
  );
  if (result.kind !== "success") return result;
  return ok(result.data.items);
}

export async function fetchRecommendations(
  trackId: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Track[]>> {
  const p = provider ?? (env !== undefined ? getPreferredProvider(env) : getPreferredProvider());
  const result = await safeFetch(p, "tracks.recommendations", () =>
    p.getRecommendations(trackId, { limit: 6 }),
  );
  if (result.kind !== "success") return result;
  return ok(result.data.items);
}
