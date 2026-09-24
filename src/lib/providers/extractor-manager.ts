import type { SerializedEngineError, Track } from "@/lib/domain";
import {
  ExtractorError,
  TrackNotFoundError,
  serializeEngineError,
} from "@/lib/domain";
import {
  ProviderNotFoundError,
  UnsupportedProviderCapabilityError,
} from "@/lib/errors";
import type { MusicProvider, ProviderSearchQuery } from "./types";
import {
  clearProviders,
  getProvider,
  listProviders,
  registerProvider,
} from "./registry";
import { asExtractor } from "./extractor";
import type { Extractor } from "./extractor";
import { detectSource } from "./source-detection";
import type { DetectedSource } from "./source-detection";

/**
 * Engine-facing orchestration over the single canonical provider registry
 * (`registry.ts`). This manager owns NO store of its own: registration and
 * lookup delegate to the existing registry, so there is exactly one
 * authoritative registration mechanism and one lookup path.
 *
 * Duplicate registration is deterministic: registering an id twice replaces
 * the previous entry (matching the registry's Map.set semantics) and
 * returns it. No silent second entry can exist because storage is keyed
 * by provider id.
 */

/** Production source order. Unknown/test ids sort alphabetically after. */
const CANONICAL_ORDER = ["youtube", "deezer", "spotify"] as const;

function canonicalRank(id: string): [number, string] {
  const index = (CANONICAL_ORDER as readonly string[]).indexOf(id);
  return index === -1 ? [CANONICAL_ORDER.length, id] : [index, ""];
}

function orderProviders(providers: MusicProvider[]): MusicProvider[] {
  return [...providers].sort((a, b) => {
    const [rankA, tieA] = canonicalRank(a.id);
    const [rankB, tieB] = canonicalRank(b.id);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return tieA < tieB ? -1 : tieA > tieB ? 1 : 0;
  });
}

export type ExtractorSearchStatus = "success" | "empty" | "unsupported" | "failed";

export interface ExtractorSearchOutcome {
  provider: string;
  status: ExtractorSearchStatus;
  tracks: Track[];
  total?: number;
  /** Normalized failure; present only when status is "failed". */
  error?: SerializedEngineError;
}

export interface FanoutSearchResult {
  query: string;
  outcomes: ExtractorSearchOutcome[];
  /** Aggregated successful tracks in deterministic outcome order. */
  tracks: Track[];
  /** True when at least one provider returned success (possibly empty). */
  succeeded: boolean;
}

export interface FanoutSearchOptions {
  /** Explicit provider subset. Unknown ids become failed outcomes. */
  providers?: string[];
  limit?: number;
}

export type TrackLookupRef =
  | DetectedSource
  | { provider: string; id: string };

async function searchOne(
  provider: MusicProvider,
  query: ProviderSearchQuery,
): Promise<ExtractorSearchOutcome> {
  if (!provider.capabilities.has("search.tracks")) {
    return { provider: provider.id, status: "unsupported", tracks: [] };
  }
  try {
    const result = await provider.searchTracks(query);
    const tracks = result.items ?? [];
    return {
      provider: provider.id,
      status: tracks.length === 0 ? "empty" : "success",
      tracks,
      total: result.total,
    };
  } catch (error) {
    const normalized =
      error instanceof ExtractorError
        ? error
        : new ExtractorError(
            provider.id,
            "search",
            error instanceof Error ? error.message : "Search failed",
            { cause: error },
          );
    return {
      provider: provider.id,
      status: "failed",
      tracks: [],
      error: serializeEngineError(normalized),
    };
  }
}

export class ExtractorManager {
  /**
   * Registers a provider. Replaces any previous entry with the same id
   * and returns it (null when first registered). Deterministic: calling
   * twice with the same provider leaves exactly one active entry.
   */
  register(provider: MusicProvider): MusicProvider | null {
    let previous: MusicProvider | null = null;
    try {
      previous = getProvider(provider.id);
    } catch {
      previous = null;
    }
    registerProvider(provider);
    return previous;
  }

  unregister(name: string): boolean {
    const providers = listProviders();
    if (!providers.some((provider) => provider.id === name)) {
      return false;
    }
    const remaining = providers.filter((provider) => provider.id !== name);
    clearProviders();
    for (const provider of remaining) {
      registerProvider(provider);
    }
    return true;
  }

  /** Throws the existing `ProviderNotFoundError` for unknown ids. */
  get(name: string): MusicProvider {
    return getProvider(name);
  }

  has(name: string): boolean {
    return listProviders().some((provider) => provider.id === name);
  }

  /** Deterministic canonical order (youtube, deezer, spotify, then A-Z). */
  list(): MusicProvider[] {
    return orderProviders(listProviders());
  }

  clear(): void {
    clearProviders();
  }

  /** Engine-facing structural view of a registered provider. */
  extractor(name: string): Extractor {
    return asExtractor(getProvider(name));
  }

  /** Detects the provider source for a supported URL, else null. */
  detect(input: string): DetectedSource | null {
    return detectSource(input);
  }

  /** Resolves the registered extractor owning a supported URL, else null. */
  extractorFor(input: string): Extractor | null {
    const detected = detectSource(input);
    if (!detected) {
      return null;
    }
    try {
      return asExtractor(getProvider(detected.provider));
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fans plain-text search out across eligible providers in parallel.
   * One provider failing never discards other providers' results.
   * `succeeded` is false only when every outcome failed or was unsupported.
   */
  async searchAll(
    query: string,
    options: FanoutSearchOptions = {},
  ): Promise<FanoutSearchResult> {
    const trimmed = query.trim();
    const searchQuery: ProviderSearchQuery = {
      query: trimmed,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };

    const requested = options.providers;
    const targets =
      requested !== undefined
        ? requested.map((name) => {
            try {
              return { provider: getProvider(name), unknown: false as const };
            } catch {
              return { provider: null, unknown: true as const, name };
            }
          })
        : orderProviders(listProviders()).map((provider) => ({
            provider,
            unknown: false as const,
          }));

    const outcomes = await Promise.all(
      targets.map(async (target) => {
        if (target.unknown || target.provider === null) {
          const name =
            "name" in target && typeof target.name === "string"
              ? target.name
              : "unknown";
          return {
            provider: name,
            status: "failed" as const,
            tracks: [],
            error: serializeEngineError(
              new ExtractorError(name, "search", `Unknown provider "${name}"`),
            ),
          };
        }
        return searchOne(target.provider, searchQuery);
      }),
    );

    const tracks = outcomes.flatMap((outcome) => outcome.tracks);
    const succeeded = outcomes.some(
      (outcome) => outcome.status === "success" || outcome.status === "empty",
    );
    return { query: trimmed, outcomes, tracks, succeeded };
  }

  /**
   * Resolves a stable track reference through its owning provider.
   * Returns null only when the provider reports the track as missing
   * (`TrackNotFoundError`); transport/provider failures surface as
   * `ExtractorError`. Unregistered providers also map to
   * `TrackNotFoundError` — ids are provider-scoped, so resolving through
   * a different provider is never attempted.
   */
  async getTrack(ref: TrackLookupRef): Promise<Track | null> {
    let provider: MusicProvider;
    try {
      provider = getProvider(ref.provider);
    } catch {
      throw new TrackNotFoundError({
        provider: ref.provider,
        providerTrackId: ref.id,
      });
    }
    if (!provider.capabilities.has("tracks.get")) {
      throw new UnsupportedProviderCapabilityError(
        provider.id,
        "tracks.get",
        `getTrack is not supported by provider "${provider.id}"`,
      );
    }
    try {
      return await provider.getTrack(ref.id);
    } catch (error) {
      if (error instanceof TrackNotFoundError) {
        return null;
      }
      throw new ExtractorError(
        provider.id,
        "getTrack",
        error instanceof Error ? error.message : "Track lookup failed",
        { cause: error },
      );
    }
  }
}

/** Shared engine-facing manager over the single provider registry. */
export const extractorManager = new ExtractorManager();
