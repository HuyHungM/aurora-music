import { getEnv } from "@/lib/config/env";
import { listProviders } from "@/lib/providers/registry";
import type { MusicProvider, ProviderCapability } from "@/lib/providers/types";
import type { Album, Artist, Track } from "@/lib/domain";
import type { EnvConfig } from "@/lib/config/env";
import { ProviderNotFoundError } from "@/lib/errors";
import { ensureYouTubeProvider } from "@/lib/providers/youtube/bootstrap";
import { ensureDeezerProvider } from "@/lib/providers/deezer/bootstrap";
import { ensureSpotifyProvider } from "@/lib/providers/spotify/bootstrap";
import { parseProviderScopedId } from "@/lib/domain/scoped-id";

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

/**
 * The registered provider that can actually serve `capability`.
 *
 * WHY THIS EXISTS. `getPreferredProvider()` returns the first non-mock provider
 * in REGISTRATION order, and every caller then asked THAT provider whether it
 * supported the capability it needed. Registration order is YouTube → Deezer →
 * Spotify, and YouTube advertises only `search.tracks`, `tracks.get`,
 * `search.artists`, `artists.get` and `artists.tracks`. So on any deployment
 * with `YOUTUBE_API_KEY` set, every album/popular/featured lookup asked YouTube,
 * got `unsupported`, and the UI rendered as if the catalogue were empty — while
 * a fully capable Deezer sat registered and unconsulted. Concretely that made
 * `/album/[id]` call `notFound()`, emptied the home Popular / Featured /
 * Albums sections, and removed the search Albums section.
 *
 * The capability registry is the source of truth and is unchanged; this only
 * stops the resolution from ignoring it. Registration order is still the
 * tie-breaker, so resolution stays deterministic, and `preferProviderId` lets a
 * caller insist on the provider the DATA came from.
 *
 * Mocks are skipped unless nothing else is registered, mirroring
 * `getPreferredProvider` exactly.
 */
export function getProviderForCapability(
  capability: ProviderCapability,
  options: { preferProviderId?: string | null; env?: EnvConfig } = {},
): MusicProvider | null {
  const providers = getShellProviders(options.env ?? getEnv());

  // The provider the id actually came from wins, but only if it can serve the
  // capability — a provider-scoped id from a provider that cannot read albums
  // is no use.
  if (options.preferProviderId) {
    const preferred = providers.find(
      (provider) => provider.id === options.preferProviderId,
    );
    if (preferred?.capabilities.has(capability)) {
      return preferred;
    }
  }

  const capable = providers.find(
    (provider) => !provider.isMock && provider.capabilities.has(capability),
  );
  if (capable) {
    return capable;
  }
  // Preserve the existing mock fallback semantics: a mock-only registry still
  // serves, exactly as `getPreferredProvider` allowed.
  return providers.find((provider) => provider.capabilities.has(capability)) ?? null;
}

/**
 * Splits a provider-scoped deep-link id into its parts.
 *
 * Re-exported from the pure `./scoped-id` module, which is what client
 * components import — this file is server-only and must stay that way.
 */
export { parseProviderScopedId, providerScopedId } from "@/lib/domain/scoped-id";

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
  // Capability-aware, per section. Each of these used to be gated on the single
  // PREFERRED provider, which on any deployment with a YouTube key meant every
  // album/popular/featured lookup resolved `unsupported` and the corresponding
  // home section rendered empty — while Deezer, which has all three, was
  // registered and unconsulted.
  const popularProvider = getProviderForCapability("tracks.popular", { env });
  const featuredProvider = getProviderForCapability("tracks.featured", { env });
  const recommendationsProvider = getProviderForCapability("tracks.recommendations", { env });

  const [
    popularResult,
    featuredResult,
    recommendationsResult,
  ] = await Promise.allSettled([
    popularProvider
      ? safeFetch(popularProvider, "tracks.popular", () =>
          popularProvider.getPopularTracks({ limit: 12 }),
        )
      : Promise.resolve(unsupported),
    featuredProvider
      ? safeFetch(featuredProvider, "tracks.featured", () =>
          featuredProvider.getFeaturedTracks({ limit: 12 }),
        )
      : Promise.resolve(unsupported),
    (async () => {
      if (!recommendationsProvider) return unsupported;
      const seedTrackId = findRecommendationSeed(recentTracks, likedTracks, []);
      if (!seedTrackId) return ok({ items: [] as Track[], total: 0 });
      return safeFetch(recommendationsProvider, "tracks.recommendations", () =>
        recommendationsProvider.getRecommendations(seedTrackId, { limit: 10 }),
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
      // Hydrated per TRACK'S OWN provider. `track.albumId` is a
      // provider-scoped id, so asking a single provider for every album would
      // pass a Deezer id to YouTube (or the reverse) and return nothing.
      //
      // Also parallel, with a bounded fan-out. This loop used to `await` one
      // provider round trip per album SEQUENTIALLY — up to 12 on the home
      // first-paint path, and the same again for artists.
      const seen = new Set<string>();
      const ids = popularItems
        .filter((track) => track.albumId && !seen.has(`${track.provider}:${track.albumId}`))
        .filter((track) => {
          seen.add(`${track.provider}:${track.albumId}`);
          return true;
        });
      const settled = await Promise.allSettled(
        ids.map(async (track) => {
          const p = getProviderForCapability("albums.get", {
            preferProviderId: track.provider,
            env,
          });
          if (!p) return null;
          return safeFetch(p, "albums.get", () => p.getAlbum(track.albumId!));
        }),
      );
      const albums: Album[] = [];
      for (const entry of settled) {
        if (entry.status === "fulfilled" && entry.value?.kind === "success") {
          albums.push(entry.value.data);
        }
      }
      return albums;
    })(),
    (async () => {
      const seen = new Set<string>();
      const ids = popularItems
        .filter((track) => track.artistId && !seen.has(`${track.provider}:${track.artistId}`))
        .filter((track) => {
          seen.add(`${track.provider}:${track.artistId}`);
          return true;
        });
      const settled = await Promise.allSettled(
        ids.map(async (track) => {
          const p = getProviderForCapability("artists.get", {
            preferProviderId: track.provider,
            env,
          });
          if (!p) return null;
          return safeFetch(p, "artists.get", () => p.getArtist(track.artistId!));
        }),
      );
      const artists: Artist[] = [];
      for (const entry of settled) {
        if (entry.status === "fulfilled" && entry.value?.kind === "success") {
          artists.push(entry.value.data);
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

/**
 * Resolves the provider for a deep-link id.
 *
 * A provider-scoped id (`spotify:abc`) names its own provider; a bare id (the
 * pre-existing link format, still present in shared playlists and users'
 * history) resolves by capability. The returned resource id has the prefix
 * stripped — providers only ever saw the bare id before, and must keep doing so.
 */
function resolveForScopedId(
  raw: string,
  capability: ProviderCapability,
  explicitProvider: MusicProvider | null | undefined,
  env: EnvConfig | undefined,
): { provider: MusicProvider | null; id: string } {
  const scoped = parseProviderScopedId(raw);
  if (explicitProvider) {
    return { provider: explicitProvider, id: scoped?.id ?? raw };
  }
  const resolvedEnv = env ?? getEnv();
  const provider = getProviderForCapability(capability, {
    preferProviderId: scoped?.providerId ?? null,
    env: resolvedEnv,
  });
  return { provider, id: scoped?.id ?? raw };
}

export async function fetchArtistDetail(
  id: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Artist>> {
  const r = resolveForScopedId(id, "artists.get", provider, env);
  if (!r.provider) return unsupported;
  return safeFetch(r.provider, "artists.get", () => r.provider!.getArtist(r.id));
}

export async function fetchAlbumDetail(
  id: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Album>> {
  // Capability-aware, and honouring the id's own provider. This is what stops
  // `/album/[id]` from 404ing: the route used to ask the PREFERRED provider for
  // `albums.get`, which YouTube does not have, so the page called `notFound()`
  // no matter which provider the album actually came from.
  const r = resolveForScopedId(id, "albums.get", provider, env);
  if (!r.provider) return unsupported;
  return safeFetch(r.provider, "albums.get", () => r.provider!.getAlbum(r.id));
}

export async function fetchTrackDetail(
  id: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Track>> {
  const r = resolveForScopedId(id, "tracks.get", provider, env);
  if (!r.provider) return unsupported;
  return safeFetch(r.provider, "tracks.get", () => r.provider!.getTrack(r.id));
}

export async function fetchArtistTracks(
  artistId: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Track[]>> {
  const r = resolveForScopedId(artistId, "artists.tracks", provider, env);
  if (!r.provider) return unsupported;
  const result = await safeFetch(r.provider, "artists.tracks", () =>
    r.provider!.getArtistTracks(r.id, { limit: 50 }),
  );
  if (result.kind !== "success") return result;
  return ok(result.data.items);
}

export async function fetchAlbumTracks(
  albumId: string,
  provider?: MusicProvider | null,
  env?: EnvConfig,
): Promise<CapabilityResult<Track[]>> {
  const r = resolveForScopedId(albumId, "albums.tracks", provider, env);
  if (!r.provider) return unsupported;
  const result = await safeFetch(r.provider, "albums.tracks", () =>
    r.provider!.getAlbumTracks(r.id, { limit: 50 }),
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
