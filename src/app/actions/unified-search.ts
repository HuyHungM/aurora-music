"use server";

import type { TrackIdentity } from "@/lib/domain";
import type { ExtractorSearchOutcome } from "@/lib/providers/extractor-manager";
import { extractorManager } from "@/lib/providers/extractor-manager";
import type { UnifiedSearchDiagnostics } from "@/lib/music/unified-search";
import { createUnifiedSearch } from "@/lib/music/unified-search";
import { searchQuerySchema } from "@/lib/validation/schemas";
import { guardServerAction, type GuardFailure } from "@/lib/api/action-guard";

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
    const result = await search.search(parsed.data.query, { limit: SEARCH_LIMIT });
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
