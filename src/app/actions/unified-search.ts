"use server";

import type { TrackIdentity } from "@/lib/domain";
import type { ExtractorSearchOutcome } from "@/lib/providers/extractor-manager";
import { extractorManager } from "@/lib/providers/extractor-manager";
import type { UnifiedSearchDiagnostics } from "@/lib/music/unified-search";
import { createUnifiedSearch } from "@/lib/music/unified-search";
import { searchQuerySchema } from "@/lib/validation/schemas";
import { guardServerAction, type GuardFailure } from "@/lib/api/action-guard";
import { logger } from "@/lib/diagnostics/logger";
import { normalizeSearchQuery } from "@/lib/search/normalize";
import {
  runCachedSearch,
  searchCacheKey,
  sharedSearchCache,
} from "@/lib/search/search-cache";

export interface UnifiedSearchPayload {
  query: string;
  tracks: TrackIdentity[];
  providers: ExtractorSearchOutcome[];
  succeeded: boolean;
  partial: boolean;
  diagnostics: UnifiedSearchDiagnostics;
}

export type UnifiedSearchActionResult =
  | { ok: true; result: UnifiedSearchPayload }
  | ({ ok: false; error: string } & Partial<GuardFailure>);

const SEARCH_LIMIT = 20;

/**
 * Search fans out to every registered provider, so it is the single easiest
 * request to weaponise against a deployment's provider quota. Budgeted per
 * identity (authenticated id when there is one, a hashed client fingerprint
 * otherwise) - RULE 12.
 *
 * The budget is deliberately generous for a person and tight for a loop: 30 a
 * minute is far above continuous interactive searching and still prevents one
 * caller from owning the quota.
 */
const SEARCH_OFF_MESSAGE = "Search is temporarily unavailable right now.";

/**
 * Runs the unified multi-provider search for the search page. Everything
 * returned is plain serializable data: canonical TrackIdentity groups,
 * per-provider outcomes, flags, and diagnostics counts. No provider DTOs,
 * secrets, tokens, or playback URLs cross this boundary.
 */
export async function searchUnifiedTracksAction(
  rawQuery: unknown,
): Promise<UnifiedSearchActionResult> {
  const denied = await guardServerAction({
    featureOffMessage: SEARCH_OFF_MESSAGE,
    bucket: "search",
  });
  if (denied) {
    return denied;
  }
  const parsed = searchQuerySchema.safeParse({ query: rawQuery, limit: 20, offset: 0 });
  if (!parsed.success || parsed.data.query.length === 0) {
    return { ok: false, error: "Type a track, artist, or album name to search." };
  }
  try {
    const search = createUnifiedSearch(extractorManager);
    const startedAt = Date.now();

    // Cache key over the NORMALIZED query, so "Cam  On", "cam on" and
    // "CẢM ƠN" share one entry rather than three. The cache holds the finished
    // UnifiedSearchResult — plain serializable identities and per-provider
    // statuses, no provider DTO, no token, and nothing user-specific (search is
    // not personalized, which is what makes a shared process cache safe).
    //
    // A TOTAL failure is never cached: it is a provider condition, not a
    // result, and caching it would turn one bad minute into a sticky error
    // page. Such a key instead gets a 5s cooldown so an impatient retry loop
    // cannot storm the provider, and a partial success caches normally.
    const cache = sharedSearchCache();
    const key = searchCacheKey(normalizeSearchQuery(parsed.data.query), { limit: SEARCH_LIMIT });
    const result = await runCachedSearch({
      cache,
      key,
      isCacheable: (value) => value.succeeded,
      run: () => search.search(parsed.data.query, { limit: SEARCH_LIMIT }),
    });

    // Development/diagnostic timing. Deliberately never logs the query text:
    // counts and duration only.
    logger.debug("Unified search completed", {
      event: "search_unified_completed",
      durationMs: Date.now() - startedAt,
      providers: result.providers.length,
      groups: result.tracks.length,
      succeeded: result.succeeded,
      partial: result.partial,
      rankingMs: result.diagnostics.rankingMs,
      topBand: result.diagnostics.topBand,
      cacheHits: cache.getStats().hits,
      cacheMisses: cache.getStats().misses,
    });
    return {
      ok: true,
      result: {
        query: result.query,
        tracks: result.tracks,
        providers: result.providers,
        succeeded: result.succeeded,
        partial: result.partial,
        diagnostics: result.diagnostics,
      },
    };
  } catch {
    return { ok: false, error: "Could not reach the providers." };
  }
}
