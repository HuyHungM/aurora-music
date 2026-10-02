/**
 * The ONE canonical normalization pipeline for search queries.
 *
 * Every search layer that needs to compare text — ranking, fuzzy matching,
 * cache keys — reads this module. Nothing downstream re-implements trimming,
 * case folding, accent folding, or tokenization; `unified-search.ts` used to
 * call bare `query.trim()` and there was no accent-insensitive view of a query
 * at all, so "cam on" and "Cảm Ơn" could not be compared by any layer.
 *
 * The primitives are NOT re-implemented here either. `normalizeBase`,
 * `foldDiacritics` and `tokenize` come from `@/lib/domain/match-text`, the
 * module the calibrated TrackMatcher already compares with — so a search
 * ranking and a cross-provider merge cannot disagree about what two strings
 * "look like". That sharing is the whole point: one comparison-text language.
 *
 * WHAT IS PRESERVED. `raw` is the trimmed user text and is what providers
 * receive and what the UI displays. Nothing here rewrites a title, a display
 * name, or a stored query. Normalization is a comparison VIEW, exactly like
 * `match-text.ts` produces for merging — never a mutation of the source data.
 *
 * VIETNAMESE. Folding is combining-mark strip plus `đ→d`, which is
 * representation normalization, not transliteration:
 *   "Cảm Ơn" → "cam on"   "cam on" → "cam on"   "Đêm Của Ngày Hôm Qua" → "dem cua ngay hom qua"
 * That makes an accented query and its unaccented spelling compare equal in
 * BOTH directions, which is the actual requirement. Folding is symmetric and
 * total, so it cannot produce an asymmetric miss. It is deliberately NOT
 * applied to identity, deduplication, or merge decisions — those stay on
 * `TrackMatcher`'s calibrated `parseTitleVersion` path, where folding is
 * already applied per-signal and never as a whole-string equality test.
 *
 * COLLISIONS ARE EXPECTED AND HARMLESS HERE. Folding maps a whole Vietnamese
 * syllable set onto one ASCII spelling ("cám"/"cảm"/"căm" all become "cam"),
 * so a folded form is evidence, never proof. Ranking therefore treats an
 * exact folded match as a strong signal it corroborates with tokens, title
 * structure and provider order — it never terminates the decision alone.
 */

import {
  foldDiacritics,
  normalizeArtistName,
  normalizeBase,
  tokenize,
} from "@/lib/domain/match-text";

/**
 * Below this many characters a query is treated as a prefix probe only: no
 * fuzzy pass, no phrase containment, and no artist/title exact tier. One or
 * two characters match almost everything in a catalog, so fuzzy matching
 * there produces noise rather than recall — and the expensive tiers are the
 * only ones that cost anything. This is the same reasoning the search field
 * already applies by being submit-driven, expressed as a constant instead of
 * scattered `length > 2` checks.
 */
export const SHORT_QUERY_CHARS = 2;

/** Shortest query that may use bounded fuzzy scoring. */
export const FUZZY_MIN_QUERY_CHARS = 4;

export interface NormalizedQuery {
  /** Trimmed user text. Providers receive this; the UI displays this. */
  readonly raw: string;
  /** `normalizeBase(raw)`: NFKC, lowercased, punctuation folded to spaces. */
  readonly normalized: string;
  /** `folded`: accent-insensitive `normalized` for cross-script comparison. */
  readonly folded: string;
  /** Tokens of `normalized`, in order, duplicates preserved. */
  readonly tokens: readonly string[];
  /** Tokens of `folded`, in order, duplicates preserved. */
  readonly foldedTokens: readonly string[];
  /** True when the query is too short for fuzzy/phrase matching. */
  readonly isShort: boolean;
  /** True when the query is long enough for bounded fuzzy scoring. */
  readonly fuzzyEligible: boolean;
}

function split(value: string): readonly string[] {
  return value.length === 0 ? [] : tokenize(value);
}

/**
 * Normalizes one search query. Pure, allocation-light, and cheap enough to
 * call on every request and every candidate comparison.
 *
 * An empty/whitespace query returns a fully-formed empty value rather than
 * throwing: whether an empty query is an error is the CALLER's policy
 * (`searchQuerySchema` already rejects it upstream), and a normalizer that
 * throws forces every caller to defend against it.
 */
export function normalizeSearchQuery(raw: string): NormalizedQuery {
  const trimmed = raw.trim();
  const normalized = normalizeBase(trimmed);
  const folded = foldDiacritics(normalized);
  return {
    raw: trimmed,
    normalized,
    folded,
    tokens: split(normalized),
    foldedTokens: split(folded),
    isShort: folded.length <= SHORT_QUERY_CHARS,
    fuzzyEligible: folded.length >= FUZZY_MIN_QUERY_CHARS,
  };
}

/**
 * The normalized view of a CANDIDATE field (title, artist name, album
 * title). Same primitives as the query, so a candidate and a query are always
 * compared in the same language.
 *
 * Candidate text is provider-supplied and may be arbitrarily shaped: a title
 * of `"((("` normalizes to the empty string. Callers must treat an empty
 * candidate field as "no evidence" rather than as a match — comparing an
 * empty string for equality would otherwise make every blank provider field
 * match every blank query.
 */
export interface NormalizedField {
  readonly normalized: string;
  readonly folded: string;
  readonly tokens: readonly string[];
  readonly foldedTokens: readonly string[];
  /** True when the field carried no comparable characters. */
  readonly empty: boolean;
}

export function normalizeSearchField(value: string): NormalizedField {
  const normalized = normalizeBase(value);
  const folded = foldDiacritics(normalized);
  return {
    normalized,
    folded,
    tokens: split(normalized),
    foldedTokens: split(folded),
    empty: normalized.length === 0,
  };
}

/**
 * Convenience for artist names, which `TrackMatcher` already normalizes with
 * `normalizeArtistName`. Present so a caller ranking artists has one obvious
 * entry point; the primitive itself is not re-implemented.
 */
export function normalizeSearchArtist(name: string): NormalizedField {
  return normalizeSearchField(normalizeArtistName(name));
}
