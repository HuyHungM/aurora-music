import type { Album, Artist, Track } from "@/lib/domain";
import { mapTrackRow } from "@/lib/dal/mappers";
import { prisma } from "@/lib/db";
import { extractorManager } from "@/lib/providers/extractor-manager";
import { getProvider } from "@/lib/providers/registry";
import { getShellProviders } from "@/lib/providers/server";
import type { ProviderCapability } from "@/lib/providers/types";
import { E2E_AUTH_FLAG } from "@/../e2e/auth/constants";
import type {
  ArtistRef,
  AlbumRef,
  RadioDiscoveryBackend,
} from "./service";

/**
 * Production radio discovery backend (server-only): fans every avenue
 * out across capable providers with per-provider failure isolation.
 * Capability-driven — no hardcoded per-provider branching beyond the
 * closed production set. Never resolves playback, never caches audio.
 */
export function createProductionRadioBackend(): RadioDiscoveryBackend {
  async function fanOut<T>(capability: ProviderCapability, call: (providerId: string) => Promise<T[]>): Promise<T[]> {
    const providers = getShellProviders();
    const results = await Promise.all(
      providers.map(async (provider) => {
        if (!provider.capabilities.has(capability)) {
          return [];
        }
        try {
          return await call(provider.id);
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  async function owned<T>(
    providerId: string,
    capability: ProviderCapability,
    call: () => Promise<T>,
  ): Promise<T[]> {
    const providers = getShellProviders();
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider || !provider.capabilities.has(capability)) {
      return [];
    }
    try {
      const result = await call();
      return [result];
    } catch {
      return [];
    }
  }

  return {
    async searchTracks(query: string, limit: number): Promise<Track[]> {
      if (query.trim().length === 0) return [];
      const pages = await fanOut("search.tracks", async (providerId) => {
        const provider = getProvider(providerId);
        const result = await provider.searchTracks({ query, limit });
        return result.items;
      });
      return pages.slice(0, limit * 3);
    },

    async artistTracks(artist: ArtistRef, limit: number): Promise<Track[]> {
      const batches = await owned(artist.provider, "artists.tracks", async () => {
        const provider = getProvider(artist.provider);
        const result = await provider.getArtistTracks(artist.providerArtistId, { limit });
        return result.items;
      });
      return batches.flat().slice(0, limit);
    },

    async albumTracks(album: AlbumRef, limit: number): Promise<Track[]> {
      const batches = await owned(album.provider, "albums.tracks", async () => {
        const provider = getProvider(album.provider);
        const result = await provider.getAlbumTracks(album.providerAlbumId, { limit });
        return result.items;
      });
      return batches.flat().slice(0, limit);
    },

    async artistAlbums(artist: ArtistRef, limit: number): Promise<Album[]> {
      // Spotify exposes artist albums without artist tracks; other
      // providers resolve through the same capability-shaped call.
      const batches: Album[][] = [];
      for (const provider of getShellProviders()) {
        const extended = provider as unknown as {
          getArtistAlbums?: (
            artistId: string,
            pagination?: { limit?: number },
          ) => Promise<{ items: Album[] }>;
        };
        if (typeof extended.getArtistAlbums !== "function") {
          continue;
        }
        try {
          // Artist ids are provider-scoped: only the owning provider can
          // answer honestly; others fail closed and are skipped.
          if (provider.id !== artist.provider) {
            continue;
          }
          const result = await extended.getArtistAlbums(artist.providerArtistId, { limit });
          batches.push(result.items);
        } catch {
          // Per-avenue isolation: skip and continue.
        }
      }
      return batches.flat().slice(0, limit);
    },

    async popularTracks(limit: number): Promise<Track[]> {
      const pages = await fanOut("tracks.popular", async (providerId) => {
        const provider = getProvider(providerId);
        const result = await provider.getPopularTracks({ limit });
        return result.items;
      });
      return pages.slice(0, limit);
    },

    async getTrack(providerId: string, providerTrackId: string): Promise<Track | null> {
      try {
        return await extractorManager.getTrack({ provider: providerId, id: providerTrackId });
      } catch {
        return null;
      }
    },

    async getArtist(providerId: string, providerArtistId: string): Promise<Artist | null> {
      try {
        const provider = getProvider(providerId);
        if (!provider.capabilities.has("artists.get")) {
          return null;
        }
        return await provider.getArtist(providerArtistId);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Deterministic fixture discovery backend for authenticated E2E
 * (same test-only pattern as the fixture library page): the seeded
 * `e2e-` catalog answers every avenue from the database, so radio
 * journeys never depend on live providers. Active ONLY when
 * AURORA_E2E_AUTH=1; unreachable otherwise.
 */
export function isFixtureRadioEnabled(): boolean {
  return process.env[E2E_AUTH_FLAG] === "1";
}

export function createFixtureRadioBackend(): RadioDiscoveryBackend {
  async function fixtureTracks(): Promise<Track[]> {
    const rows = await prisma.track.findMany({
      where: { providerTrackId: { startsWith: "e2e-" } },
      include: { artist: true, album: true },
      orderBy: { providerTrackId: "asc" },
    });
    return rows.map(mapTrackRow);
  }

  function matches(track: Track, query: string): boolean {
    const folded = query.toLowerCase();
    return (
      track.title.toLowerCase().includes(folded) ||
      track.artistName.toLowerCase().includes(folded) ||
      (track.albumName ?? "").toLowerCase().includes(folded)
    );
  }

  return {
    async searchTracks(query: string, limit: number): Promise<Track[]> {
      const tracks = await fixtureTracks();
      return tracks.filter((track) => matches(track, query)).slice(0, limit);
    },
    async artistTracks(artist: ArtistRef, limit: number): Promise<Track[]> {
      const tracks = await fixtureTracks();
      return tracks
        .filter(
          (track) =>
            track.artistId === artist.providerArtistId ||
            track.artistName === artist.name,
        )
        .slice(0, limit);
    },
    async albumTracks(album: AlbumRef, limit: number): Promise<Track[]> {
      const tracks = await fixtureTracks();
      return tracks
        .filter((track) => track.albumId === album.providerAlbumId)
        .slice(0, limit);
    },
    async artistAlbums(): Promise<Album[]> {
      return [];
    },
    async popularTracks(limit: number): Promise<Track[]> {
      return (await fixtureTracks()).slice(0, limit);
    },
    async getTrack(provider: string, providerTrackId: string): Promise<Track | null> {
      const tracks = await fixtureTracks();
      return (
        tracks.find(
          (track) =>
            track.provider === provider && track.providerTrackId === providerTrackId,
        ) ?? null
      );
    },
    async getArtist(_provider: string, providerArtistId: string): Promise<Artist | null> {
      const row = await prisma.artist.findFirst({
        where: { providerArtistId },
      });
      if (!row) {
        return null;
      }
      return {
        id: row.providerArtistId,
        provider: row.provider as Artist["provider"],
        providerArtistId: row.providerArtistId,
        name: row.name,
        image: row.image ?? undefined,
      };
    },
  };
}

/** Production backend, or the deterministic fixture backend under the E2E flag. */
export function getRadioBackend(): RadioDiscoveryBackend {
  return isFixtureRadioEnabled()
    ? createFixtureRadioBackend()
    : createProductionRadioBackend();
}
