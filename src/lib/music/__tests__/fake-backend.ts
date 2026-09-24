import type { Track } from "@/lib/domain";
import type {
  ExtractorSearchOutcome,
  FanoutSearchOptions,
  FanoutSearchResult,
} from "@/lib/providers/extractor-manager";

/**
 * Test-only search backend. Never registered anywhere near production;
 * injected per-test into `createUnifiedSearch`.
 */

let counter = 0;

export function track(
  provider: string,
  overrides: Partial<Track> = {},
): Track {
  counter += 1;
  const id = `${provider}-t${counter}`;
  return {
    id,
    provider,
    providerTrackId: id,
    title: "Song",
    artistId: `${provider}-a1`,
    artistName: "Artist",
    duration: 200,
    providerUrl: `https://example.invalid/${provider}/${id}`,
    ...overrides,
  };
}

export function outcome(
  provider: string,
  tracks: Track[] = [],
  status: ExtractorSearchOutcome["status"] = tracks.length > 0 ? "success" : "empty",
): ExtractorSearchOutcome {
  return { provider, status, tracks };
}

export function failedOutcome(provider: string): ExtractorSearchOutcome {
  return {
    provider,
    status: "failed",
    tracks: [],
    error: {
      name: "ExtractorError",
      code: "EXTRACTOR_ERROR",
      message: `${provider} boom`,
      retryable: true,
      provider,
    },
  };
}

export interface FakeBackend {
  searchAll(query: string, options?: FanoutSearchOptions): Promise<FanoutSearchResult>;
  calls: Array<{ query: string; options?: FanoutSearchOptions }>;
}

export function fakeBackend(outcomes: ExtractorSearchOutcome[]): FakeBackend {
  const calls: FakeBackend["calls"] = [];
  return {
    calls,
    async searchAll(query: string, options?: FanoutSearchOptions) {
      calls.push({ query, options });
      return {
        query,
        outcomes: outcomes.map((outcome) => ({ ...outcome, tracks: [...outcome.tracks] })),
        tracks: outcomes.flatMap((outcome) => outcome.tracks),
        succeeded: outcomes.some(
          (outcome) => outcome.status === "success" || outcome.status === "empty",
        ),
      };
    },
  };
}
