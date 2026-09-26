import type { TrackIdentity } from "@/lib/domain";
import { toTrackIdentity } from "@/lib/domain";
import {
  generateRankedRadioBatch,
  identityKeys,
  type ArtistRef,
  type RadioDiscoveryBackend,
  type RadioMode,
} from "@/lib/radio/service";

/**
 * Aurora recommendation service (Phase 47, server-side).
 *
 * ```text
 *   Signals
 *      ↓
 *   Candidate generation   (per category, bounded)
 *      ↓
 *   Normalization + matching   (generateRankedRadioBatch → groupCandidates)
 *      ↓
 *   Deduplication          (canonical key sets, cross-category)
 *      ↓
 *   Filtering              (queue / played / already-recommended)
 *      ↓
 *   Ranking                (shared rankGroups score + affinity)
 *      ↓
 *   Diversity              (interleaveWithDiversity)
 *      ↓
 *   Recommendation result
 * ```
 *
 * Deliberate scope: a deterministic, explainable pipeline over the
 * providers Aurora already has. It introduces NO vector store, NO
 * embeddings, NO external recommendation API, and NO learned model — the
 * repository has no such infrastructure and §82 forbids inventing one.
 * Ranking reuses `rankGroups` rather than forking it, so recommendations
 * and radio score on the same real evidence.
 *
 * It owns NO playback, NO audio, NO queue mutation, and NO caching. The
 * queue stays the persistent artifact; nothing here is stored, and
 * listening history never leaves the server.
 */

/** Bounded per-category candidate ask. Never unbounded. */
export const RECOMMENDATION_AVENUE_LIMIT = 8;
/** Default number of recommendations in a set. */
export const RECOMMENDATION_SET_SIZE = 12;
/** Signals (artist names) read from a single history source. */
export const RECOMMENDATION_SIGNAL_CAP = 6;
/** Absolute ceiling on how many category batches one run may ask for. */
export const MAX_RECOMMENDATION_BATCHES = 4;

/**
 * §21 categories. Each names only what the pipeline can actually justify
 * from real data — the service never claims "personalized" without a real
 * signal behind it, and an anonymous caller gets `continue-discovering`
 * alone.
 */
export type RecommendationCategory =
  | "similar-to-current"
  | "because-you-listened"
  | "from-artists-you-follow"
  | "based-on-likes"
  | "continue-discovering";

export interface RecommendationTrackRef {
  provider: string;
  providerTrackId: string;
}

export interface RecommendationSeedTrack extends RecommendationTrackRef {
  artistName?: string;
}

export interface RecommendationSignals {
  /** The track playing right now, when the surface has one. */
  currentTrack?: RecommendationSeedTrack | null;
  /** Artist names from recently played, most recent first. */
  recentArtists?: string[];
  /** Artist names from liked tracks, most recent first. */
  likedArtists?: string[];
  /** Artists the listener follows, provider-scoped. */
  followedArtists?: ArtistRef[];
  /**
   * Canonical keys to never return: the current queue, already-played
   * tracks, and previously recommended keys. Supplied by the caller (the
   * client knows the queue; the server merges recent history).
   */
  excludeKeys?: Iterable<string>;
}

export interface Recommendation {
  /** Canonical primary key, stable for consumer-side de-duplication. */
  key: string;
  identity: TrackIdentity;
  category: RecommendationCategory;
  /**
   * Human-readable justification drawn from real data (an artist name, the
   * current track's artist). Never a fabricated score or percentage.
   */
  reason: string | null;
  /** Deterministic combined score, exposed for tests and diagnostics. */
  score: number;
  /** Evidence labels from the shared ranker (same-artist, cross-source…). */
  reasons: string[];
}

export interface RecommendationSet {
  items: Recommendation[];
  /** Categories that produced at least one track, in pipeline order. */
  categories: RecommendationCategory[];
  /** True when no category produced a new candidate. */
  exhausted: boolean;
}

export const EMPTY_RECOMMENDATION_SET: RecommendationSet = {
  items: [],
  categories: [],
  exhausted: true,
};

/**
 * Artist-diversity policy (§51). The target shape is
 * A B C A D — a repeated artist is fine, a run of the same artist is not.
 */
export const MAX_CONSECUTIVE_SAME_ARTIST = 1;
/** Preferred ceiling per artist across one set. */
export const RECOMMENDATIONS_PER_ARTIST = 2;
/** Absolute ceiling per artist before the relaxation pass. */
export const MAX_RECOMMENDATIONS_PER_ARTIST = 3;

/** §26 affinity weights. Real, deterministic, and additive. */
export const AFFINITY_FOLLOWED = 60;
export const AFFINITY_LIKED = 40;
export const AFFINITY_RECENT = 25;

function artistNameOf(identity: TrackIdentity): string {
  return identity.artists[0]?.name ?? "";
}

/**
 * Canonical keys as a stable array. `identityKeys` returns a Set; the
 * primary key is used as the result's public `key`, so it must be
 * materialized in a defined order rather than read off set iteration.
 */
function keysArray(identity: TrackIdentity): string[] {
  return [...identityKeys(identity)];
}

function folded(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function foldedList(values: readonly string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const value of values ?? []) {
    const key = folded(value);
    if (key.length > 0) {
      out.add(key);
    }
  }
  return out;
}

/**
 * Interleaves ranked candidates so one artist cannot dominate, while
 * guaranteeing a full result when the pool is small.
 *
 * Deterministic strict-pass-then-relax: the strict pass applies the streak
 * and per-artist rules and defers whatever they reject; the relaxation pass
 * releases deferred items in original score order once the rules would
 * otherwise starve the result (§50: relax filters gradually instead of
 * returning nothing). Survivors keep their relative score order, so the
 * ranker's output is preserved within what the diversity rules allow.
 */
export function interleaveWithDiversity<T extends { artistName: string }>(
  ranked: readonly T[],
  limit: number,
): T[] {
  if (ranked.length === 0 || limit <= 0) {
    return [];
  }
  const out: T[] = [];
  const deferred: T[] = [];
  const perArtist = new Map<string, number>();
  let streak = "";
  let streakCount = 0;

  for (const entry of ranked) {
    if (out.length >= limit) {
      break;
    }
    const artist = folded(entry.artistName);
    const artistCount = perArtist.get(artist) ?? 0;
    const sameAsStreak = artist.length > 0 && artist === streak;
    const streakBlocked = sameAsStreak && streakCount >= MAX_CONSECUTIVE_SAME_ARTIST;
    const capBlocked = artistCount >= MAX_RECOMMENDATIONS_PER_ARTIST;
    if (streakBlocked || capBlocked) {
      deferred.push(entry);
      continue;
    }
    out.push(entry);
    perArtist.set(artist, artistCount + 1);
    streak = artist;
    streakCount = artist.length > 0 ? (sameAsStreak ? streakCount + 1 : 1) : 0;
  }

  if (out.length < limit) {
    for (const entry of deferred) {
      if (out.length >= limit) {
        break;
      }
      out.push(entry);
    }
  }
  return out;
}

interface CategoryPlan {
  category: RecommendationCategory;
  mode: RadioMode;
  reason: string | null;
}

/**
 * Builds the category plan from the signals that ACTUALLY exist. A category
 * with no signal behind it is never planned, which is how §21's "do not
 * claim personalized without enough information" is enforced structurally
 * rather than by convention.
 */
function planCategories(signals: RecommendationSignals): CategoryPlan[] {
  const plans: CategoryPlan[] = [];

  if (signals.currentTrack?.provider && signals.currentTrack.providerTrackId) {
    plans.push({
      category: "similar-to-current",
      mode: "track",
      reason: signals.currentTrack.artistName ?? null,
    });
  }

  const recent = (signals.recentArtists ?? []).filter((name) => name.trim().length > 0);
  if (recent.length > 0) {
    plans.push({ category: "because-you-listened", mode: "discovery", reason: recent[0] as string });
  }

  const followed = (signals.followedArtists ?? []).filter((artist) => artist.name.trim().length > 0);
  if (followed.length > 0) {
    plans.push({
      category: "from-artists-you-follow",
      mode: "artist",
      reason: (followed[0] as ArtistRef).name,
    });
  }

  const liked = (signals.likedArtists ?? []).filter((name) => name.trim().length > 0);
  if (liked.length > 0) {
    plans.push({ category: "based-on-likes", mode: "discovery", reason: liked[0] as string });
  }

  if (plans.length === 0) {
    // Anonymous or brand-new listener: popular-catalog discovery only. This
    // is the non-personalized fallback, and it is honest about being so.
    plans.push({ category: "continue-discovering", mode: "discovery", reason: null });
  }

  return plans.slice(0, MAX_RECOMMENDATION_BATCHES);
}

/**
 * Resolves a seed reference through the shared catalog.
 *
 * Every failure mode resolves to `null` rather than throwing: a provider
 * lookup can reject (network, rate limit, malformed payload) exactly like a
 * venue search can, and one rejecting lookup must not take down a whole
 * recommendation run or a queue continuation (§63).
 */
async function resolveSeedIdentity(
  backend: RadioDiscoveryBackend,
  ref: RecommendationTrackRef,
): Promise<TrackIdentity | null> {
  try {
    const track = await backend.getTrack(ref.provider, ref.providerTrackId);
    if (!track) {
      return null;
    }
    return toTrackIdentity(track);
  } catch {
    return null;
  }
}

interface Affinity {
  followed: Set<string>;
  liked: Set<string>;
  recent: Set<string>;
}

function buildAffinity(signals: RecommendationSignals): Affinity {
  return {
    followed: foldedList((signals.followedArtists ?? []).map((artist) => artist.name)),
    liked: foldedList(signals.likedArtists),
    recent: foldedList(signals.recentArtists),
  };
}

/** Real, explainable affinity contribution (§26). No invented ML score. */
function affinityFor(artistName: string, affinity: Affinity): number {
  const key = folded(artistName);
  if (key.length === 0) {
    return 0;
  }
  let score = 0;
  if (affinity.followed.has(key)) {
    score += AFFINITY_FOLLOWED;
  }
  if (affinity.liked.has(key)) {
    score += AFFINITY_LIKED;
  }
  if (affinity.recent.has(key)) {
    score += AFFINITY_RECENT;
  }
  return score;
}

interface Candidate extends Recommendation {
  artistName: string;
  order: number;
}

/**
 * Generates one bounded, deduplicated, diversity-ordered recommendation
 * set.
 *
 * Never throws for provider or candidate problems: a failing category is
 * dropped and the remaining ones still produce a result (§63). Only a
 * genuinely empty result set is reported, which callers treat as "nothing
 * to recommend" rather than as a failure worth retrying.
 */
export async function generateRecommendations(
  backend: RadioDiscoveryBackend,
  signals: RecommendationSignals,
  limit: number = RECOMMENDATION_SET_SIZE,
): Promise<RecommendationSet> {
  const bounded = Math.max(0, Math.min(limit, RECOMMENDATION_SET_SIZE * 2));
  if (bounded === 0) {
    return EMPTY_RECOMMENDATION_SET;
  }

  const excluded = new Set<string>(signals.excludeKeys ?? []);
  const affinity = buildAffinity(signals);
  const plans = planCategories(signals);
  const textSignals = [...(signals.recentArtists ?? []), ...(signals.likedArtists ?? [])]
    .filter((name) => typeof name === "string" && name.trim().length > 0)
    .slice(0, RECOMMENDATION_SIGNAL_CAP);
  const followedArtist = (signals.followedArtists ?? []).filter(
    (artist) => artist.name.trim().length > 0,
  )[0] as ArtistRef | undefined;

  const used = new Set<string>();
  const collected: Candidate[] = [];
  const categories: RecommendationCategory[] = [];
  let order = 0;
  /**
   * Set when a signal-backed avenue could not run — an unresolvable seed, a
   * rejecting venue. It gates a single non-personalized discovery retry
   * below, so a provider hiccup degrades the result rather than emptying it.
   */
  let signalAvenueLost = false;

  const runPlan = async (
    plan: CategoryPlan,
  ): Promise<void> => {
    let seed: TrackIdentity | undefined;
    if (plan.mode === "track") {
      const ref = signals.currentTrack;
      if (!ref) {
        signalAvenueLost = true;
        return;
      }
      seed = (await resolveSeedIdentity(backend, ref)) ?? undefined;
      if (!seed) {
        // Seed unresolvable. Do not sink the surface: mark the signal
        // avenue lost and let the discovery fallback below cover it.
        signalAvenueLost = true;
        return;
      }
    }
    if (plan.mode === "artist" && !followedArtist) {
      signalAvenueLost = true;
      return;
    }

    let ranked: Array<{ identity: TrackIdentity; score: number; reasons: string[] }>;
    try {
      const batch = await generateRankedRadioBatch(backend, {
        mode: plan.mode,
        ...(seed ? { seed } : {}),
        ...(followedArtist ? { seedArtist: followedArtist } : {}),
        signals: textSignals,
        // A copy of the caller's exclusions. The cross-category `used` set
        // is applied below, so a duplicate is dropped once, in one place.
        excludeKeys: new Set(excluded),
        limit: RECOMMENDATION_AVENUE_LIMIT,
      });
      ranked = batch.ranked;
    } catch {
      // §63: one avenue/category failing never sinks the set.
      signalAvenueLost = true;
      return;
    }

    let produced = 0;
    for (const entry of ranked) {
      const keys = keysArray(entry.identity);
      if (keys.length === 0) {
        continue;
      }
      // §25: a canonical track appears once per result. A key claimed by an
      // earlier category, or excluded by the caller (queue, already played,
      // already recommended), is dropped — never globally de-duplicated
      // against the queue itself, only within this set.
      if (keys.some((key) => excluded.has(key) || used.has(key))) {
        continue;
      }
      for (const key of keys) {
        used.add(key);
      }
      const artistName = artistNameOf(entry.identity);
      collected.push({
        key: keys[0] as string,
        identity: entry.identity,
        category: plan.category,
        reason: plan.reason,
        score: entry.score + affinityFor(artistName, affinity),
        reasons: entry.reasons,
        artistName,
        order: order++,
      });
      produced += 1;
    }
    if (produced > 0) {
      categories.push(plan.category);
    }
  };

  for (const plan of plans) {
    await runPlan(plan);
  }

  // §50/§63: relax rather than return nothing. If every signal-backed avenue
  // was lost (unresolvable seed, rejecting provider) and nothing was found,
  // make exactly ONE non-personalized discovery attempt. Bounded on purpose —
  // this is a fallback, not a retry loop, and it never runs when the
  // personalized avenues already produced something.
  if (collected.length === 0 && signalAvenueLost) {
    await runPlan({ category: "continue-discovering", mode: "discovery", reason: null });
  }

  if (collected.length === 0) {
    return { items: [], categories: [], exhausted: true };
  }

  // Combined score first, discovery order as the stable tie-break.
  const byScore = [...collected].sort(
    (a, b) => b.score - a.score || a.order - b.order,
  );
  const diversified = interleaveWithDiversity(byScore, bounded);

  return {
    // The internal ranking bookkeeping (`artistName`, `order`) is dropped
    // here rather than exposed: it is a pipeline detail, and leaking it into
    // the public result type would invite consumers to depend on it.
    items: diversified.map((candidate) => ({
      key: candidate.key,
      identity: candidate.identity,
      category: candidate.category,
      reason: candidate.reason,
      score: candidate.score,
      reasons: candidate.reasons,
    })),
    categories,
    exhausted: false,
  };
}
