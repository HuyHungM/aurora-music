import { getLibraryArtistNames } from "@/lib/dal/library";
import { listFollowedArtists } from "@/lib/dal/follow";
import { listRecent } from "@/lib/dal/recently-played";
import type { RecommendationSignals } from "./service";

/**
 * Server-side personalization signals for the recommendation pipeline
 * (Phase 47).
 *
 * Every signal is read from Aurora's own database, on the server. No
 * component ever sends listening history anywhere, and nothing is forwarded
 * to a third-party recommendation service — the only outbound calls this
 * feature makes are the catalog/metadata calls Aurora already makes for
 * search and radio.
 *
 * Every read is individually fault-tolerant. A failure yields fewer signals,
 * never an error: popular-catalog discovery is a perfectly good fallback, and
 * a broken history query must not take a page down.
 */

/** Upper bound on any single history read. Bounded on purpose. */
export const RECOMMENDATION_SIGNAL_READ_LIMIT = 20;

const NO_SIGNALS = {
  recentArtists: [] as string[],
  likedArtists: [] as string[],
  followedArtists: [] as RecommendationSignals["followedArtists"],
};

/**
 * Recent history doubles as an exclusion set, exactly as radio does, so
 * already-played tracks cannot come back as a recommendation.
 */
export async function recentHistoryExcludeKeys(userId: string | null): Promise<string[]> {
  if (!userId) {
    return [];
  }
  try {
    const recent = await listRecent(userId, RECOMMENDATION_SIGNAL_READ_LIMIT);
    return recent.map((entry) => `${entry.provider}:${entry.trackId}`);
  } catch {
    return [];
  }
}

/**
 * Reads the listener's real signals. Returns empty sets for an anonymous or
 * brand-new listener, which is what routes the pipeline to non-personalized
 * popular-catalog discovery instead of pretending to be personalized.
 */
export async function collectRecommendationSignals(
  userId: string | null,
): Promise<typeof NO_SIGNALS> {
  if (!userId) {
    return NO_SIGNALS;
  }
  try {
    // Artist names only, so this is the narrow projection rather than the
    // library rendering read: it never needed a playlist, an album row, or a
    // hydrated `Track`, and loading them for one string per row was the whole
    // cost of personalizing a page.
    const [names, follows] = await Promise.all([
      getLibraryArtistNames(userId, { likedLimit: 20, recentLimit: 10 }),
      listFollowedArtists(userId, { limit: 5 }),
    ]);
    return {
      recentArtists: names.recentArtists,
      likedArtists: names.likedArtists,
      followedArtists: follows.map((follow) => ({
        provider: follow.artist.provider,
        providerArtistId: follow.artist.providerArtistId ?? follow.artist.id,
        name: follow.artist.name,
      })),
    };
  } catch {
    return NO_SIGNALS;
  }
}
