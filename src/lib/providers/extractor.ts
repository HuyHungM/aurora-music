import type { Album, Artist, AudioSource, Track } from "@/lib/domain";
import { ExtractorError, TrackNotFoundError } from "@/lib/domain";
import { UnsupportedProviderCapabilityError } from "@/lib/errors";
import type {
  MusicProvider,
  ProviderCapability,
  ProviderListResult,
  ProviderSearchQuery,
} from "./types";
import { detectSource } from "./source-detection";

/**
 * Engine-facing extractor contract.
 *
 * Architectural note: this does NOT replace `MusicProvider`. It is a
 * minimal structural view over the canonical provider contract so engine
 * code can depend on input/search/lookup behavior without touching the
 * full domain API. `MusicProvider` remains the single source of truth;
 * `asExtractor` adapts it. There is exactly one registry (`registry.ts`).
 *
 * `getPlaylist` stays optional: the existing provider contract has no
 * provider-playlist concept (Aurora playlists are user-owned), and
 * collection playback arrives in a later phase.
 */
export interface Extractor {
  /** Extractor name; always equals the backing provider id. */
  readonly name: string;

  /** True when the input is a URL this extractor can resolve. */
  validate(input: string): boolean;

  search(query: ProviderSearchQuery): Promise<ProviderListResult<Track>>;

  getTrack(identifier: string): Promise<Track | null>;

  getPlaylist?(identifier: string): Promise<unknown | null>;

  getAlbum?(identifier: string): Promise<Album | null>;

  getArtist?(identifier: string): Promise<Artist | null>;
}

/**
 * Playback-capable extractor boundary. Only YouTube will implement this;
 * Deezer and Spotify must NOT be forced to. `resolve` is intentionally
 * unimplemented in Phase 02 — the contract exists so later phases have a
 * typed target. Never persist the returned URL (see `AudioSource`).
 */
export interface PlayableExtractor extends Extractor {
  resolve(track: Track): Promise<AudioSource>;
}

/** True when the extractor exposes playback resolution. */
export function isPlayableExtractor(
  extractor: Extractor,
): extractor is PlayableExtractor {
  return (
    typeof (extractor as Partial<PlayableExtractor>).resolve === "function"
  );
}

function wrapExtractorError(
  providerId: string,
  operation: string,
  error: unknown,
): never {
  if (error instanceof TrackNotFoundError) {
    throw error;
  }
  throw new ExtractorError(
    providerId,
    operation,
    error instanceof Error ? error.message : "Extractor operation failed",
    { cause: error },
  );
}

function requireCapability(
  provider: MusicProvider,
  capability: ProviderCapability,
  operation: string,
): void {
  if (!provider.capabilities.has(capability)) {
    throw new UnsupportedProviderCapabilityError(
      provider.id,
      capability,
      `${operation} is not supported by provider "${provider.id}"`,
    );
  }
}

/**
 * Adapts the canonical `MusicProvider` to the engine-facing `Extractor`
 * view. Capability checks run BEFORE invoking provider methods, so
 * unsupported operations never trigger provider calls.
 */
export function asExtractor(provider: MusicProvider): Extractor {
  return {
    name: provider.id,

    validate(input: string): boolean {
      const detected = detectSource(input);
      return detected !== null && detected.provider === provider.id;
    },

    async search(query: ProviderSearchQuery): Promise<ProviderListResult<Track>> {
      requireCapability(provider, "search.tracks", "search");
      try {
        return await provider.searchTracks(query);
      } catch (error) {
        wrapExtractorError(provider.id, "search", error);
      }
    },

    async getTrack(identifier: string): Promise<Track | null> {
      requireCapability(provider, "tracks.get", "getTrack");
      try {
        return await provider.getTrack(identifier);
      } catch (error) {
        wrapExtractorError(provider.id, "getTrack", error);
      }
    },

    async getAlbum(identifier: string): Promise<Album | null> {
      requireCapability(provider, "albums.get", "getAlbum");
      try {
        return await provider.getAlbum(identifier);
      } catch (error) {
        wrapExtractorError(provider.id, "getAlbum", error);
      }
    },

    async getArtist(identifier: string): Promise<Artist | null> {
      requireCapability(provider, "artists.get", "getArtist");
      try {
        return await provider.getArtist(identifier);
      } catch (error) {
        wrapExtractorError(provider.id, "getArtist", error);
      }
    },
  };
}
