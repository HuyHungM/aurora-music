/**
 * Unified multi-provider search and source-enrichment orchestration.
 *
 * Pipeline (each layer keeps its own responsibility):
 *
 * ```text
 * query
 *   -> normalizeSearchQuery()         (one canonical comparison view)
 *   -> ExtractorManager.searchAll()   (provider I/O, parallel fan-out)
 *   -> toTrackIdentity()              (canonicalization, one per track)
 *   -> TrackMatcher.match()           (pairwise equivalence, exact|strong only)
 *   -> mergeSourceReference()         (explicit enrichment, primary preserved)
 *   -> rankSearchResults()            (deterministic relevance order)
 *   -> UnifiedSearchResult
 * ```
 *
 * Rules enforced here:
 * - Only `exact` and `strong` classifications auto-merge. `possible` and
 *   `rejected` always stay separate (false positives cost more than dupes).
 * - Ties (two or more qualifying groups) stay separate: no ambiguous merges.
 * - Same provider+source id refreshes the existing group, never duplicates.
 * - Primary source and group identity id are preserved across merges.
 * - GROUPING IS NOT RANKING. `TrackMatcher` answers "are these two rows the
 *   same recording?" and is never re-tuned; `rankSearchResults` answers "which
 *   of these results does the person mean?" and only reorders. Neither reads
 *   the other's thresholds, so improving one cannot silently move the other.
 * - No popularity, no playback, no persistence. Ranking is local arithmetic
 *   over rows the providers already returned — it issues no request.
 * - Provider tracks are never mutated; groups are new immutable values.
 * - Matcher thresholds are never adjusted here (Phase 07 stays calibrated).
 */

import type {
  ExtractorSearchOutcome,
  FanoutSearchOptions,
  FanoutSearchResult,
} from "@/lib/providers/extractor-manager";
import type {
  MatchClassification,
  TrackIdentity,
  TrackMatcher,
} from "@/lib/domain";
import {
  AUTO_MERGE_CLASSIFICATIONS,
  createTrackMatcher,
  mergeSourceReference,
  sourceReferenceKey,
  toTrackIdentity,
} from "@/lib/domain";
import { NormalizationError } from "@/lib/domain";
import { normalizeSearchQuery } from "@/lib/search/normalize";
import type { NormalizedQuery } from "@/lib/search/normalize";
import { rankSearchResults } from "@/lib/search/rank";

/** Minimal search backend surface; ExtractorManager satisfies it. */
export interface SearchBackend {
  searchAll(query: string, options?: FanoutSearchOptions): Promise<FanoutSearchResult>;
}

export interface UnifiedSearchOptions extends FanoutSearchOptions {
  /** Injected matcher (default: calibrated matcher). Never retuned here. */
  matcher?: TrackMatcher;
  /** Injected backend (default: shared extractor manager). */
  backend?: SearchBackend;
  /**
   * Rank results for relevance (default true). Set false only for a caller
   * that deliberately wants provider order — nothing in the product does, and
   * provider order is exactly the "first row wins" behaviour that put a live
   * cover above the exact match.
   */
  rank?: boolean;
}

export interface UnifiedSearchDiagnostics {
  /** Canonical groups produced. */
  groups: number;
  /** Explicit source merges performed. */
  mergedSources: number;
  /** Candidates matching two or more groups (kept separate). */
  ties: number;
  /** Provider tracks skipped as uncanonicalizable. */
  skippedMalformed: number;
  /** Matcher classifications observed across pairwise evaluations. */
  matchCounts: Record<MatchClassification, number>;
  /** Milliseconds spent ranking, excluding provider I/O and grouping. */
  rankingMs: number;
  /** Highest rank band the top result reached, or null for an empty result. */
  topBand: string | null;
}

export interface UnifiedSearchResult {
  query: string;
  /**
   * Canonical groups, best match first.
   *
   * Before ranking this was "first-seen order", which meant the first
   * provider's first row took the top slot — measured on a realistic
   * fan-out, a live cover outranked the exact match. Order is now relevance
   * order; ties fall back to first-seen, so the determinism guarantee is
   * unchanged.
   */
  tracks: TrackIdentity[];
  /** Untouched provider outcomes (success/empty/unsupported/failed). */
  providers: ExtractorSearchOutcome[];
  /** True when at least one provider succeeded (possibly empty). */
  succeeded: boolean;
  /** True when usable results coexist with failed/unsupported providers. */
  partial: boolean;
  diagnostics: UnifiedSearchDiagnostics;
}

/**
 * Classifications allowed to auto-merge. `possible` never merges.
 *
 * Read from the matcher module rather than restated here: duplicate rejection
 * (`domain/track-dedupe.ts`) reads the same constant, and two copies of "what
 * counts as the same song" is precisely the drift this repository's
 * canonical-identity work exists to prevent.
 */
const MERGEABLE = AUTO_MERGE_CLASSIFICATIONS;

function emptyDiagnostics(): UnifiedSearchDiagnostics {
  return {
    groups: 0,
    mergedSources: 0,
    ties: 0,
    skippedMalformed: 0,
    matchCounts: { exact: 0, strong: 0, possible: 0, rejected: 0 },
    rankingMs: 0,
    topBand: null,
  };
}

export interface UnifiedSearch {
  search(query: string, options?: UnifiedSearchOptions): Promise<UnifiedSearchResult>;
}

interface Grouping {
  groups: TrackIdentity[];
}

function findClaimedGroup(grouping: Grouping, key: string): number {
  return grouping.groups.findIndex((group) =>
    group.sources.some((source) => sourceReferenceKey(source) === key),
  );
}

export function createUnifiedSearch(backend: SearchBackend): UnifiedSearch {
  return {
    async search(query: string, options: UnifiedSearchOptions = {}): Promise<UnifiedSearchResult> {
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        throw new NormalizationError("query", "Unified search requires a non-empty query");
      }
      const matcher = options.matcher ?? createTrackMatcher();
      // The single canonical comparison view, built once per request and
      // shared with ranking. Providers still receive `trimmed`: folding is a
      // comparison concern, and sending a folded query upstream would ask
      // YouTube to search for a spelling the person did not type.
      const normalized = normalizeSearchQuery(trimmed);
      const fanout = await backend.searchAll(trimmed, {
        ...(options.providers !== undefined ? { providers: options.providers } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });

      const diagnostics = emptyDiagnostics();
      const grouping: Grouping = { groups: [] };

      for (const outcome of fanout.outcomes) {
        for (const track of outcome.tracks) {
          let candidate: TrackIdentity;
          try {
            candidate = toTrackIdentity(track);
          } catch {
            // One malformed provider track never sinks the search.
            diagnostics.skippedMalformed += 1;
            continue;
          }
          const candidateKey = sourceReferenceKey(candidate.primarySource);
          const claimedIndex = findClaimedGroup(grouping, candidateKey);
          if (claimedIndex !== -1) {
            // Same provider resource seen again: refresh, never duplicate.
            const current = grouping.groups[claimedIndex] as TrackIdentity;
            grouping.groups[claimedIndex] = mergeSourceReference(
              current,
              candidate.primarySource,
            );
            diagnostics.mergedSources += 1;
            continue;
          }

          const qualifying: number[] = [];
          for (let index = 0; index < grouping.groups.length; index += 1) {
            const group = grouping.groups[index] as TrackIdentity;
            const result = matcher.match(candidate, group);
            diagnostics.matchCounts[result.classification] += 1;
            if (result.matched && MERGEABLE.includes(result.classification)) {
              qualifying.push(index);
            }
          }

          if (qualifying.length === 1) {
            const target = grouping.groups[qualifying[0] as number] as TrackIdentity;
            grouping.groups[qualifying[0] as number] = mergeSourceReference(
              target,
              candidate.primarySource,
            );
            diagnostics.mergedSources += 1;
          } else {
            if (qualifying.length > 1) {
              // Ambiguous: keep separate rather than merge incorrectly.
              diagnostics.ties += 1;
            }
            grouping.groups.push(candidate);
          }
        }
      }

      diagnostics.groups = grouping.groups.length;

      // Ranking runs last, on the merged groups, and only reorders. It is
      // timed separately from grouping because the two have different causes:
      // grouping cost scales with the pairwise matcher, ranking cost scales
      // with the number of surviving groups. A regression in either should be
      // attributable from the diagnostics alone.
      const ranked = orderGroups(grouping.groups, normalized, options.rank !== false);
      diagnostics.rankingMs = ranked.rankingMs;
      diagnostics.topBand = ranked.topBand;

      const partial =
        fanout.succeeded &&
        fanout.outcomes.some(
          (outcome) => outcome.status === "failed" || outcome.status === "unsupported",
        );
      return {
        query: fanout.query,
        tracks: ranked.groups,
        providers: fanout.outcomes,
        succeeded: fanout.succeeded,
        partial,
        diagnostics,
      };
    },
  };
}

interface OrderedGroups {
  groups: TrackIdentity[];
  rankingMs: number;
  topBand: string | null;
}

/**
 * Applies relevance order to the merged groups, or leaves provider order
 * intact when ranking is switched off. A clock is passed in rather than read
 * from `Date.now` directly so a test can make the timing assertion
 * deterministic; the default stays the real clock.
 */
function orderGroups(
  groups: TrackIdentity[],
  query: NormalizedQuery,
  rank: boolean,
  now: () => number = Date.now,
): OrderedGroups {
  if (!rank || groups.length === 0) {
    return { groups, rankingMs: 0, topBand: null };
  }
  const startedAt = now();
  const ranked = rankSearchResults(query, groups);
  return {
    groups: ranked.map((entry) => entry.identity),
    rankingMs: Math.max(0, now() - startedAt),
    topBand: ranked[0]?.band ?? null,
  };
}

/**
 * Enriches one canonical identity with explicitly supplied candidate
 * identities. A candidate merges (ALL of its sources, explicitly) only on
 * an `exact`/`strong` match; otherwise the identity is returned unchanged.
 * Inputs are never mutated; a new identity is returned on every merge.
 */
export function enrichIdentity(
  identity: TrackIdentity,
  candidates: TrackIdentity[],
  matcher: TrackMatcher = createTrackMatcher(),
): TrackIdentity {
  let current = identity;
  for (const candidate of candidates) {
    // Cheap exact refresh first: shared source keys merge without scoring.
    const shared = candidate.sources.filter((source) =>
      current.sources.some(
        (existing) => sourceReferenceKey(existing) === sourceReferenceKey(source),
      ),
    );
    if (shared.length > 0) {
      for (const source of shared) {
        current = mergeSourceReference(current, source);
      }
      continue;
    }
    const result = matcher.match(candidate, current);
    if (result.matched && MERGEABLE.includes(result.classification)) {
      for (const source of candidate.sources) {
        current = mergeSourceReference(current, source);
      }
    }
  }
  return current;
}
