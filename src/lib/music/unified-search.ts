/**
 * Unified multi-provider search and source-enrichment orchestration.
 *
 * Pipeline (each layer keeps its own responsibility):
 *
 * ```text
 * query
 *   -> ExtractorManager.searchAll()   (provider I/O, parallel fan-out)
 *   -> toTrackIdentity()              (canonicalization, one per track)
 *   -> TrackMatcher.match()           (pairwise equivalence, exact|strong only)
 *   -> mergeSourceReference()         (explicit enrichment, primary preserved)
 *   -> UnifiedSearchResult            (deterministic first-seen group order)
 * ```
 *
 * Rules enforced here:
 * - Only `exact` and `strong` classifications auto-merge. `possible` and
 *   `rejected` always stay separate (false positives cost more than dupes).
 * - Ties (two or more qualifying groups) stay separate: no ambiguous merges.
 * - Same provider+source id refreshes the existing group, never duplicates.
 * - Primary source and group identity id are preserved across merges.
 * - No provider ranking, no popularity, no playback, no persistence.
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
  createTrackMatcher,
  mergeSourceReference,
  sourceReferenceKey,
  toTrackIdentity,
} from "@/lib/domain";
import { NormalizationError } from "@/lib/domain";

/** Minimal search backend surface; ExtractorManager satisfies it. */
export interface SearchBackend {
  searchAll(query: string, options?: FanoutSearchOptions): Promise<FanoutSearchResult>;
}

export interface UnifiedSearchOptions extends FanoutSearchOptions {
  /** Injected matcher (default: calibrated matcher). Never retuned here. */
  matcher?: TrackMatcher;
  /** Injected backend (default: shared extractor manager). */
  backend?: SearchBackend;
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
}

export interface UnifiedSearchResult {
  query: string;
  /** Canonical groups in deterministic first-seen order. */
  tracks: TrackIdentity[];
  /** Untouched provider outcomes (success/empty/unsupported/failed). */
  providers: ExtractorSearchOutcome[];
  /** True when at least one provider succeeded (possibly empty). */
  succeeded: boolean;
  /** True when usable results coexist with failed/unsupported providers. */
  partial: boolean;
  diagnostics: UnifiedSearchDiagnostics;
}

/** Classifications allowed to auto-merge. `possible` never merges. */
const MERGEABLE: readonly MatchClassification[] = ["exact", "strong"];

function emptyDiagnostics(): UnifiedSearchDiagnostics {
  return {
    groups: 0,
    mergedSources: 0,
    ties: 0,
    skippedMalformed: 0,
    matchCounts: { exact: 0, strong: 0, possible: 0, rejected: 0 },
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
      const partial =
        fanout.succeeded &&
        fanout.outcomes.some(
          (outcome) => outcome.status === "failed" || outcome.status === "unsupported",
        );
      return {
        query: fanout.query,
        tracks: grouping.groups,
        providers: fanout.outcomes,
        succeeded: fanout.succeeded,
        partial,
        diagnostics,
      };
    },
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
