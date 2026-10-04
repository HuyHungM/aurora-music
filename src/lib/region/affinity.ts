/**
 * Market context and region affinity — one place, so no caller invents its own
 * idea of "Vietnamese music".
 *
 * WHY THIS EXISTS. Measured on the real app for a `vi` listener, the search
 * distribution was bimodal: a Vietnamese query (`nhạc chill`, `nhạc mới`,
 * `nhạc buồn`) returned 14/14, 20/20 and 14/14 Vietnamese, because the QUERY
 * already carried the signal and every provider matched it. But the generic
 * discovery queries returned no Vietnamese at all — `pop` returned 0 of 20 —
 * because nothing in the pipeline ever asked "which market is this listener
 * in", and a neutral fan-out surfaces the global catalogue.
 *
 * So two things were missing and both live here: a MARKET (who is asking) and
 * an AFFINITY (how Vietnamese a candidate is). The ranking side lives in
 * `src/lib/search/rank.ts`; the recommendation side in
 * `src/lib/recommendations/service.ts`. Neither computes it for itself.
 *
 * NOT A GEOLOCATION SERVICE. Market comes from the app's own `Locale` and, at
 * most, the browser's region subtag. No IP lookup, no GPS, no coordinates: the
 * ranking needs a market, not a place.
 */

import type { TrackIdentity } from "@/lib/domain";
import type { Locale } from "@/lib/i18n/locale";

/** The only two markets Aurora ranks for. Anything else is the neutral case. */
export type Market = "VN" | "GLOBAL";

/**
 * How Vietnamese a candidate is.
 *
 * `unknown` is a real, common answer — it means "no signal", NOT
 * "international", and it is deliberately NOT given Vietnamese points. Treating
 * absence as evidence would make every unlabelled track look local, which is
 * the same failure as hardcoding a Vietnamese artist list.
 */
export type RegionAffinity = "vietnam" | "international" | "unknown";

/**
 * Detail points a market boost can contribute.
 *
 * Bounded by `REGION_POINTS_MAX` so `detail + region` still fits inside one
 * band (see `rank.ts`). This is a TIE-BREAKER WITHIN a band, never a band of
 * its own: an exact match for `Taylor Swift` outranks a Vietnamese match
 * because it sits in a higher band, not because 20 points beat 0.
 *
 * No Southeast-Asian tier. There is no reliable SEA classifier in the provider
 * metadata, and a fabricated one would be a guess dressed as a weight. Add it
 * when a provider exposes the metadata to earn it.
 */
export const REGION_AFFINITY_POINTS: Record<RegionAffinity, number> = {
  vietnam: 20,
  international: 0,
  unknown: 0,
};

/** Hard ceiling on the region term. `rank.ts` reserves exactly this much. */
export const REGION_POINTS_MAX = 20;

/**
 * Votes needed to call a candidate Vietnamese from text alone.
 *
 * Two, because no single signal is trustworthy: Vietnamese titles exist with
 * no diacritics (`3107`, `ONL`, `Wrong`), and non-Vietnamese titles exist with
 * characters that look Vietnamese (`Chloé`, `Bô`, `Édith`). One strong signal
 * (a Vietnamese-exclusive letter or tone vowel, or a genre tag) clears the bar;
 * the weak ones have to corroborate each other.
 */
const VIETNAM_VOTE_THRESHOLD = 2;

/**
 * Letters no other Latin-script language uses but Vietnamese: `đ`, `ă`, `ơ`,
 * `ư`. `â ê ô` are deliberately excluded — French, Portuguese and Romanian
 * use them, so alone they prove nothing.
 */
const STRONG_VIETNAMESE = /[đăĐĂơƠưƯ]/u;

/** Precomposed Vietnamese tone vowels, U+1EA0..U+1EF9 (Lao shares the block). */
const TONE_VOWEL = /[\u1EA0-\u1EF9]/u;

/** Weak script signal: a shared diacritic or a bare combining tone mark. */
const WEAK_VIETNAMESE = /[âêôÂÊÔ]|\u0300-\u036F/u;

/**
 * Folded, Vietnamese-specific vocabulary. Every token is >= 4 characters so a
 * short fold that collides with English or another language's name (`em`, `ay`,
 * `me`, `bo`) cannot vote by itself. A false positive costs one tie-breaking
 * vote and can never exclude a result; a false negative costs a track its
 * boost. That asymmetry is deliberate.
 */
const VIETNAMESE_LEXICON = new Set([
  "anh",
  "buon",
  "cam",
  "chua",
  "duoc",
  "khong",
  "lang",
  "minh",
  "moi",
  "muon",
  "nguoi",
  "nho",
  "nhac",
  "nhung",
  "nang",
  "quen",
  "thuong",
  "tinh",
  "tranh",
  "viet",
  "vietnam",
  "vietnamese",
  "vpop",
  "yeu",
]);

/** Genre / tag values that name the market outright. */
const VIETNAMESE_GENRE =
  /^(v[-\s]?pop|vpop|vietnam|vietnamese|viet\s*rap|rap\s*vi(et)?t?)$/iu;

/** ISO 639-1, 639-2, or the English name for Vietnamese. */
function isVietnameseLanguageTag(value: string): boolean {
  const tag = value.trim().toLowerCase();
  return tag === "vi" || tag === "vie" || tag === "vietnamese";
}

/** Case/diacritic-insensitive word split, shared with the lexicon check. */
function foldedWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/gu, "")
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}

/** Every string the classifier is allowed to read. */
function textOf(identity: TrackIdentity): string {
  return [
    identity.title,
    identity.album?.title ?? "",
    ...identity.artists.map((artist) => artist.name),
  ].join(" ");
}

function hasVietnameseGenre(identity: TrackIdentity): boolean {
  return identity.artists.some((artist) =>
    (artist.genres ?? []).some((genre) =>
      typeof genre === "string" && VIETNAMESE_GENRE.test(genre.trim()),
    ),
  );
}

/**
 * Classifies one candidate's regional affinity.
 *
 * Never guesses. `unknown` is returned whenever the evidence is absent, and it
 * carries zero points — so "no metadata" can never masquerade as "local".
 */
export function regionAffinityOf(identity: TrackIdentity): RegionAffinity {
  // Authoritative first, in both directions. A provider that reports a
  // language knows more than a heuristic does, even when the title has
  // diacritics. `TrackIdentity.metadata` is the provider's own descriptive bag
  // (explicit flags, live state, disc numbers), so a `language` key in it is a
  // provider statement rather than a guess.
  const reported = identity.metadata?.language;
  if (typeof reported === "string" && reported.trim().length > 0) {
    return isVietnameseLanguageTag(reported) ? "vietnam" : "international";
  }

  if (hasVietnameseGenre(identity)) {
    return "vietnam";
  }

  const text = textOf(identity);
  let votes = 0;
  if (STRONG_VIETNAMESE.test(text) || TONE_VOWEL.test(text)) {
    votes += 2;
  } else if (WEAK_VIETNAMESE.test(text)) {
    votes += 1;
  }
  if (foldedWords(text).some((word) => VIETNAMESE_LEXICON.has(word))) {
    votes += 1;
  }

  return votes >= VIETNAM_VOTE_THRESHOLD ? "vietnam" : "unknown";
}

/** The detail points a candidate earns under a market. */
export function regionPointsFor(
  identity: TrackIdentity,
  market: Market,
): number {
  return market === "VN" ? REGION_AFFINITY_POINTS[regionAffinityOf(identity)] : 0;
}

/**
 * The listener's market.
 *
 * Fallback order, exactly as the brief asks: the app's own locale first, then
 * the browser's region subtag, then neutral. `vi` is Aurora's shipped default
 * locale, so a listener who never chose anything is already `VN` — no extra
 * preference surface and no stored setting is needed to get local results.
 */
export function marketForLocale(
  locale: Locale,
  browserLanguage?: string | null,
): Market {
  if (locale === "vi") {
    return "VN";
  }
  // An English UI says nothing about where the listener is, so only a browser
  // tag that actually names the region may promote the market.
  const region = browserLanguage?.trim().split(/[-_]/)[1]?.toUpperCase();
  return region === "VN" ? "VN" : "GLOBAL";
}
