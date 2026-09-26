import type { Track } from "@/lib/domain";
import { identityToTrack } from "@/lib/music/identity-track";
import { getSessionUserId } from "@/lib/dal/session";
import { getRadioBackend } from "@/lib/radio/backend";
import {
  RECOMMENDATION_SET_SIZE,
  generateRecommendations,
  type RecommendationCategory,
  type RecommendationSignals,
  type RecommendationSeedTrack,
} from "./service";
import {
  collectRecommendationSignals,
  recentHistoryExcludeKeys,
} from "./signals";

/**
 * Server-side entry point for the static recommendation sections (Phase 47).
 *
 * Pages call this directly instead of round-tripping through a server
 * action, so rendering a section costs no extra client/server hop. The
 * pipeline is identical to the one the client coordinator uses — same
 * service, same signals, same ranking — so a track suggested on the track
 * page and a track appended to the queue are produced by one implementation
 * rather than two that can drift.
 */

export interface RecommendationSectionInput {
  /** Anchor track. Makes the section "similar to what you're on". */
  seed?: RecommendationSeedTrack | null;
  /** Canonical keys to exclude: the tracks already on the page. */
  excludeKeys?: readonly string[];
  limit?: number;
  /** Cap for the exclusion set, so a long page cannot build a huge query. */
  maxExcludeKeys?: number;
}

export interface RecommendationSectionResult {
  tracks: Track[];
  categories: RecommendationCategory[];
}

export const EMPTY_SECTION: RecommendationSectionResult = { tracks: [], categories: [] };

/**
 * Builds one section's tracks. Never throws: a provider outage or a broken
 * backend yields an empty section, and the page simply renders no
 * recommendation block rather than an error wall (§63).
 */
export async function buildRecommendationSection(
  input: RecommendationSectionInput = {},
): Promise<RecommendationSectionResult> {
  try {
    const userId = await getSessionUserId().catch(() => null);
    const signals = await collectRecommendationSignals(userId);
    const recent = await recentHistoryExcludeKeys(userId);
    const maxExclude = input.maxExcludeKeys ?? RECOMMENDATION_SET_SIZE * 4;
    const excludeKeys = [...(input.excludeKeys ?? []), ...recent].slice(-maxExclude);

    const full: RecommendationSignals = {
      ...signals,
      currentTrack: input.seed ?? null,
      excludeKeys,
    };
    const set = await generateRecommendations(
      getRadioBackend(),
      full,
      input.limit ?? RECOMMENDATION_SET_SIZE,
    );
    if (set.items.length === 0) {
      return EMPTY_SECTION;
    }
    return {
      tracks: set.items.map((item) => identityToTrack(item.identity)),
      categories: set.categories,
    };
  } catch {
    return EMPTY_SECTION;
  }
}
