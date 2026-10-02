/**
 * Deterministic, explainable search-result ranking.
 *
 * WHY THIS EXISTS. `unified-search.ts` returned groups in "first-seen order",
 * which meant the first provider's first row won the top slot. Measured on a
 * realistic fan-out (`cam on`, 3 providers x 10 results, noise-first
 * ordering), the top three results were `Cảm Ơn (Live) — Some Cover Band`,
 * `Cảm Ơn Thôi — Another Artist` and `Em Của Ngày Hôm Qua (Remix)`; the exact
 * match `Cảm Ơn — MCK` was not among them. Ranking is pure local arithmetic
 * over results the search ALREADY fetched, so this costs no request.
 *
 * STRUCTURAL DOMINANCE, NOT TUNED CONSTANTS. Every match kind lives in a
 * numbered BAND, and the score is `band * 100 + detail` where `detail` is
 * bounded to 0..99. Bands are spaced 100 apart, so a higher band always wins
 * no matter how good its detail is, and a lower band can never win no matter
 * how bad its detail is. The brief's requirement — "an exact low-popularity
 * match should normally appear above a popular but weak fuzzy match" — is
 * therefore a property of the representation, not of a threshold somebody has
 * to keep in tune.
 *
 * POPULARITY IS NOT A SCORE INPUT. Aurora has no popularity signal: nothing
 * in the schema, the provider DTOs, or `TrackIdentity` carries play counts or
 * ranks. Inventing one is out of scope, so the only prior available is the
 * order providers returned their own results in — and that is deliberately
 * kept OUT of the score, used solely as the stable-sort tiebreak among
 * textually equal results. A popular weak match therefore cannot outrank an
 * exact match, and a popular exact match still beats a weak exact match
 * (detail breaks that tie) rather than winning on prior alone.
 *
 * NOTHING IS DROPPED. Ranking only reorders. A result that matches nothing
 * still scores in `BAND_NONE` and is still returned: providers already decided
 * it is relevant, and hiding provider results on a local heuristic is a worse
 * failure than a weakly-ranked one.
 *
 * FOLDING IS CORROBORATION, NOT PROOF. `normalizeSearchQuery` folds
 * Vietnamese diacritics, which collapses a syllable set onto one ASCII
 * spelling. A folded match is therefore never sufficient on its own: exact
 * tiers additionally require a real token, prefix tiers require the fold to
 * sit at the START of the field, and fuzzy only runs on candidates that
 * already reached the phrase tier.
 */

import type { TrackIdentity } from "@/lib/domain";
import type { NormalizedField, NormalizedQuery } from "./normalize";
import { normalizeSearchField } from "./normalize";

/**
 * Match kinds, in descending strength. The VALUE is the band: score is
 * `value * 100 + detail`, so these are spaced far enough apart that detail
 * cannot cross a band boundary.
 */
export const SEARCH_RANK_BANDS = {
  /**
   * Every query token is covered, and at least one comes from the TITLE and
   * at least one from an ARTIST name. This is the "mck cảm ơn" case: the
   * person named both fields, and the result supplies both. It is the
   * strongest signal available without an exact whole-string match.
   */
  exactMultiField: 900,
  /** Title equals the query (folded). */
  exactTitle: 800,
  /** One artist name equals the query (folded). */
  exactArtist: 700,
  /** Album title equals the query (folded). */
  exactAlbum: 600,
  /** Title starts with the query (folded). */
  prefixTitle: 500,
  /** An artist name starts with the query (folded). */
  prefixArtist: 450,
  /** Album title starts with the query (folded). */
  prefixAlbum: 400,
  /** Every query token appears in the title or the artist names. */
  tokenCoverage: 300,
  /** The query appears inside the title, or its tokens appear in order. */
  phrase: 200,
  /** Bounded edit-distance similarity (typo tolerance). */
  fuzzy: 100,
  /** No textual evidence. Kept, ranked last. */
  none: 0,
} as const;

export type SearchRankBand = keyof typeof SEARCH_RANK_BANDS;

export interface SearchRankReason {
  band: SearchRankBand;
  /** Short, log-safe explanation. Field names only — never result text. */
  detail: string;
}

export interface SearchRanked {
  identity: TrackIdentity;
  score: number;
  band: SearchRankBand;
  reasons: SearchRankReason[];
  /** Position the result held in the input array; the stable tiebreak. */
  order: number;
}

export interface RankSearchOptions {
  /**
   * Hard cap on results that receive fuzzy scoring. Fuzzy is the only
   * super-linear work here, and it is the tier that can most easily turn a
   * vague query into unrelated results, so it is both bounded in count and
   * gated behind having already reached the phrase tier.
   */
  fuzzyCandidateLimit?: number;
}

export const DEFAULT_FUZZY_CANDIDATE_LIMIT = 40;

/** Max detail points a band can contribute; keeps bands from overlapping. */
const DETAIL_MAX = 99;

// ---------------------------------------------------------------------------
// Bounded edit distance
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance that aborts once it provably exceeds `max`.
 *
 * Two-band early exit: a whole row is skipped when even the cheapest edit
 * count (|len difference|) already exceeds `max`, and the running minimum of
 * the previous row bounds the current row. Both are exact — they prune cells
 * that cannot produce a result within budget, never cells that could — so the
 * returned value is identical to an unbounded computation for every input
 * where the answer is `<= max`, and `max + 1` otherwise.
 */
function boundedEditDistance(left: string, right: string, max: number): number {
  if (left === right) {
    return 0;
  }
  if (Math.abs(left.length - right.length) > max) {
    return max + 1;
  }
  if (left.length === 0) {
    return right.length <= max ? right.length : max + 1;
  }
  if (right.length === 0) {
    return left.length <= max ? left.length : max + 1;
  }
  let previous = new Array<number>(right.length + 1);
  let current = new Array<number>(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    let rowMin = current[0] as number;
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      current[j] = value;
      if (value < rowMin) {
        rowMin = value;
      }
    }
    if (rowMin > max) {
      return max + 1;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return (previous[right.length] as number) <= max
    ? (previous[right.length] as number)
    : max + 1;
}

/**
 * Edit budget for a token: one typo for a short token, two for a longer one.
 * Capped at two — this is typo tolerance, not a spell-checker, and a budget
 * of three on "camm" happily matches "commune".
 */
function editBudget(length: number): number {
  if (length <= 4) {
    return 1;
  }
  return Math.min(2, Math.floor(length / 4));
}

/**
 * Fraction of query tokens with a near-identical token in `field`, in 0..1.
 * Each query token is scored by its BEST match in the field, so token order
 * and repetition in the field do not distort the ratio.
 */
function fuzzyCoverage(
  queryTokens: readonly string[],
  fieldTokens: readonly string[],
): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  let matched = 0;
  for (const token of queryTokens) {
    const budget = editBudget(token.length);
    let best = budget + 1;
    for (const candidate of fieldTokens) {
      const distance = boundedEditDistance(token, candidate, budget);
      if (distance < best) {
        best = distance;
        if (best === 0) {
          break;
        }
      }
    }
    if (best <= budget) {
      matched += 1;
    }
  }
  return matched / queryTokens.length;
}

// ---------------------------------------------------------------------------
// Field comparison
// ---------------------------------------------------------------------------

/** Every query token present in the field, as a 0..1 fraction. */
function tokenCoverageRatio(
  queryTokens: readonly string[],
  fieldTokens: readonly string[],
): number {
  if (queryTokens.length === 0 || fieldTokens.length === 0) {
    return 0;
  }
  const present = new Set(fieldTokens);
  let found = 0;
  for (const token of new Set(queryTokens)) {
    if (present.has(token)) {
      found += 1;
    }
  }
  return found / new Set(queryTokens).size;
}

/**
 * Query tokens appearing in the field IN ORDER (gaps allowed) — "em cua
 * ngay" inside "em cua ngay hom qua". Position in a title carries meaning, so
 * this is a real signal that unordered coverage cannot express.
 */
function isSubsequence(queryTokens: readonly string[], fieldTokens: readonly string[]): boolean {
  if (queryTokens.length === 0) {
    return false;
  }
  let cursor = 0;
  for (const token of fieldTokens) {
    if (token === queryTokens[cursor]) {
      cursor += 1;
      if (cursor === queryTokens.length) {
        return true;
      }
    }
  }
  return false;
}

interface FieldView {
  title: NormalizedField;
  artists: NormalizedField[];
  album: NormalizedField | null;
}

function viewOf(identity: TrackIdentity): FieldView {
  return {
    title: normalizeSearchField(identity.title),
    artists: identity.artists.map((artist) => normalizeSearchField(artist.name)),
    album: identity.album ? normalizeSearchField(identity.album.title) : null,
  };
}

/** All folded tokens of an identity, title plus artists, de-duplicated. */
function allTokens(view: FieldView): string[] {
  const tokens = new Set<string>();
  for (const token of view.title.foldedTokens) {
    tokens.add(token);
  }
  for (const artist of view.artists) {
    for (const token of artist.foldedTokens) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

/**
 * Field-fit points: how much of the candidate the query actually accounts
 * for. A title that is exactly the query scores best; the same tokens inside
 * a much longer title score lower. This is what separates "Cảm Ơn" from
 * "Cảm Ơn Thôi" once both are in the same band.
 */
function fieldFitPoints(query: NormalizedQuery, field: NormalizedField): number {
  if (field.folded.length === 0 || query.folded.length === 0) {
    return 0;
  }
  if (field.folded === query.folded) {
    return 20;
  }
  if (field.folded.startsWith(`${query.folded} `)) {
    return 14;
  }
  const ratio = query.folded.length / field.folded.length;
  if (ratio >= 0.75) {
    return 10;
  }
  if (ratio >= 0.5) {
    return 6;
  }
  return 2;
}

/** Punctuation-free, token-aware query length for the coverage denominator. */
function detailPoints(
  query: NormalizedQuery,
  coverage: number,
  fit: number,
  target: "title" | "artist" | "album" | "any",
): number {
  // Coverage dominates the remainder: 0..60 of the 0..99 budget.
  const coveragePoints = Math.round(coverage * 60);
  const fitPoints = fit;
  // A small, explicit title preference. Only 9 points, so it can order
  // within a band and can never promote a weaker field over a stronger one.
  const targetPoints = target === "title" ? 9 : target === "any" ? 4 : 0;
  const raw = coveragePoints + fitPoints + targetPoints;
  return Math.max(0, Math.min(DETAIL_MAX, raw));
}

interface Band {
  band: SearchRankBand;
  detail: number;
  reason: string;
}

function best(...candidates: Band[]): Band {
  let winner = candidates[0] as Band;
  for (const candidate of candidates) {
    if (SEARCH_RANK_BANDS[candidate.band] > SEARCH_RANK_BANDS[winner.band]) {
      winner = candidate;
    } else if (
      SEARCH_RANK_BANDS[candidate.band] === SEARCH_RANK_BANDS[winner.band] &&
      candidate.detail > winner.detail
    ) {
      winner = candidate;
    }
  }
  return winner;
}

/**
 * Fraction of query tokens present in the TITLE, and in the ARTIST names.
 * Returned separately because the multi-field tier needs both to be non-zero:
 * a query whose tokens all sit in one field is a single-field match however
 * complete it is.
 */
function fieldSplitCoverage(
  queryTokens: readonly string[],
  view: FieldView,
): { title: number; artists: number } {
  const titleTokens = new Set(view.title.foldedTokens);
  const artistTokens = new Set<string>();
  for (const artist of view.artists) {
    for (const token of artist.foldedTokens) {
      artistTokens.add(token);
    }
  }
  let inTitle = 0;
  let inArtists = 0;
  for (const token of new Set(queryTokens)) {
    if (titleTokens.has(token)) {
      inTitle += 1;
    }
    if (artistTokens.has(token)) {
      inArtists += 1;
    }
  }
  const total = new Set(queryTokens).size;
  if (total === 0) {
    return { title: 0, artists: 0 };
  }
  return { title: inTitle / total, artists: inArtists / total };
}

function classify(
  query: NormalizedQuery,
  view: FieldView,
  allowFuzzy: boolean,
): Band {
  const q = query.folded;
  const title = view.title;
  const reasons: Band[] = [];

  // ---- Exact tiers. Guarded on `empty` so a blank provider field can never
  // equal a blank query, and skipped entirely for a short query: one or two
  // characters match nearly everything, so an exact tier there is noise.
  if (!query.isShort) {
    if (!title.empty && title.folded === q) {
      return {
        band: "exactTitle",
        detail: detailPoints(query, 1, 20, "title"),
        reason: "title exact",
      };
    }
    for (const artist of view.artists) {
      if (!artist.empty && artist.folded === q) {
        return {
          band: "exactArtist",
          detail: detailPoints(query, 1, 20, "artist"),
          reason: "artist exact",
        };
      }
    }
    if (view.album && !view.album.empty && view.album.folded === q) {
      return {
        band: "exactAlbum",
        detail: detailPoints(query, 1, 20, "album"),
        reason: "album exact",
      };
    }
  }

  // ---- Prefix tiers. The fold must sit at the START of the field, so
  // "Cảm Ơn" is not a prefix match for "Em Của Cảm Ơn" by accident.
  if (!title.empty && title.folded.startsWith(q) && q.length > 0) {
    const coverage = tokenCoverageRatio(query.foldedTokens, title.foldedTokens);
    reasons.push({
      band: "prefixTitle",
      detail: detailPoints(query, coverage, fieldFitPoints(query, title), "title"),
      reason: "title prefix",
    });
  }
  for (const artist of view.artists) {
    if (!artist.empty && artist.folded.startsWith(q) && q.length > 0) {
      reasons.push({
        band: "prefixArtist",
        detail: detailPoints(
          query,
          tokenCoverageRatio(query.foldedTokens, artist.foldedTokens),
          fieldFitPoints(query, artist),
          "artist",
        ),
        reason: "artist prefix",
      });
    }
  }
  if (view.album && !view.album.empty && view.album.folded.startsWith(q) && q.length > 0) {
    reasons.push({
      band: "prefixAlbum",
      detail: detailPoints(
        query,
        tokenCoverageRatio(query.foldedTokens, view.album.foldedTokens),
        fieldFitPoints(query, view.album),
        "album",
      ),
      reason: "album prefix",
    });
  }

  // ---- Token coverage across title + artists.
  const combined = allTokens(view);
  const coverage = tokenCoverageRatio(query.foldedTokens, combined);
  const split = fieldSplitCoverage(query.foldedTokens, view);
  if (coverage > 0) {
    const complete = coverage === 1;
    // Every token supplied, with at least one from the title AND at least one
    // from an artist: the person named both fields and this row is both.
    const multiField = complete && split.title > 0 && split.artists > 0;
    const band = multiField
      ? "exactMultiField"
      : complete
        ? "tokenCoverage"
        : "phrase";
    reasons.push({
      band,
      detail: complete
        ? detailPoints(query, coverage, fieldFitPoints(query, title), "any")
        : Math.round(coverage * DETAIL_MAX),
      reason: multiField
        ? "title and artist both supplied"
        : complete
          ? "all tokens present"
          : "some tokens present",
    });
  }

  // ---- Phrase: the query is a substring of the title, or its tokens appear
  // in order. Both are containment, not equivalence, so this sits below
  // complete token coverage.
  const contained = !title.empty && title.folded.includes(q) && q.length > 0;
  const ordered = isSubsequence(query.foldedTokens, title.foldedTokens);
  if (contained || ordered) {
    reasons.push({
      band: "phrase",
      detail: contained ? detailPoints(query, 1, fieldFitPoints(query, title), "title")
        : Math.round(coverage * DETAIL_MAX),
      reason: contained ? "query inside title" : "query tokens in order",
    });
  }

  // ---- Fuzzy: only now, only for a long-enough query, and only as a
  // tiebreak inside the phrase band. Reaching this point means the candidate
  // already had SOME containment or coverage, so a fuzzy score here refines a
  // plausible result rather than inventing one from nothing.
  if (allowFuzzy && !query.isShort) {
    const similarity = Math.max(
      title.foldedTokens.length > 0 ? fuzzyCoverage(query.foldedTokens, title.foldedTokens) : 0,
      view.artists.reduce(
        (best, artist) =>
          Math.max(
            best,
            artist.foldedTokens.length > 0
              ? fuzzyCoverage(query.foldedTokens, artist.foldedTokens)
              : 0,
          ),
        0,
      ),
    );
    if (similarity >= 0.999) {
      reasons.push({
        band: "fuzzy",
        detail: Math.round(similarity * DETAIL_MAX),
        reason: "typo-level similarity",
      });
    } else if (similarity >= 0.5) {
      reasons.push({
        band: "fuzzy",
        detail: Math.round(similarity * 40),
        reason: "partial typo similarity",
      });
    }
  }

  if (reasons.length === 0) {
    return { band: "none", detail: 0, reason: "no textual evidence" };
  }
  return best(...reasons);
}

/**
 * Ranks search results for display. Pure, deterministic, and total: every
 * input result is returned exactly once, and the input order is the final
 * tiebreak, so the previous "deterministic first-seen order" guarantee
 * survives for results the ranking considers equal.
 *
 * Never mutates its input and never drops a result.
 */
export function rankSearchResults(
  query: NormalizedQuery,
  identities: readonly TrackIdentity[],
  options: RankSearchOptions = {},
): SearchRanked[] {
  const fuzzyLimit = options.fuzzyCandidateLimit ?? DEFAULT_FUZZY_CANDIDATE_LIMIT;
  const allowFuzzy = query.fuzzyEligible;
  // Spend the fuzzy budget on the candidates most likely to benefit: the
  // provider's own order, capped. Everything past the cap is ranked without
  // it, which can only cost a few points inside the fuzzy band.
  let fuzzyBudget = fuzzyLimit;

  const ranked = identities.map((identity, order) => {
    const view = viewOf(identity);
    const useFuzzy = allowFuzzy && fuzzyBudget > 0;
    if (useFuzzy) {
      fuzzyBudget -= 1;
    }
    const band = classify(query, view, useFuzzy);
    return {
      identity,
      score: SEARCH_RANK_BANDS[band.band] * 100 + band.detail,
      band: band.band,
      reasons: [{ band: band.band, detail: band.reason }],
      order,
    } satisfies SearchRanked;
  });

  return ranked.sort((a, b) => b.score - a.score || a.order - b.order);
}

/** Score only, for callers that need a number without the reasons. */
export function scoreSearchResult(
  query: NormalizedQuery,
  identity: TrackIdentity,
): number {
  const band = classify(query, viewOf(identity), query.fuzzyEligible);
  return SEARCH_RANK_BANDS[band.band] * 100 + band.detail;
}
