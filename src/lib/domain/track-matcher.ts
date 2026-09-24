/**
 * Deterministic pairwise TrackMatcher over canonical TrackIdentity data.
 *
 * Answers ONLY "do these representations refer to the same logical track?"
 * It never merges identities, never selects playback, never touches the
 * network, the database, or the player. Callers that want to record a
 * positive result must explicitly call `mergeSourceReference` themselves.
 *
 * Decision model (all constants below are named and documented):
 * - Exact same-provider same-source id -> `exact` immediately.
 * - Otherwise weighted evidence sum plus an independent hard-rejection
 *   layer: semantic contradictions (version/title/artist/duration) reject
 *   regardless of score. False positives are treated as more dangerous
 *   than missed weak matches.
 * - Confidence is evidence strength, not identity proof. Only the
 *   same-source shortcut is exact by construction.
 *
 * Symmetric by construction (set comparisons, absolute differences, fixed
 * evidence order) and free of randomness, timestamps, and I/O.
 */

import { sourceReferenceKey } from "./source-reference";
import type { TrackIdentity } from "./track-identity";
import {
  compareVersions,
  foldDiacritics,
  identityIsrcs,
  normalizeArtistName,
  normalizeBase,
  parseTitleVersion,
  tokenize,
  tokenOverlap,
} from "./match-text";

// ---------------------------------------------------------------------------
// Duration tolerances (absolute first; relative only extends "close").
// A 2s gap means something different on a 20s clip vs a 5min song, so the
// close band grows with duration up to a hard cap. Beyond 30s absolute,
// same-recording agreement is implausible and rejects outright.
// ---------------------------------------------------------------------------
export const DURATION_STRONG_MS = 2000;
export const DURATION_CLOSE_MS = 5000;
export const DURATION_CLOSE_REL_RATIO = 0.05;
export const DURATION_CLOSE_REL_CAP_MS = 15000;
export const DURATION_LARGE_MS = 15000;
export const DURATION_HARD_REJECT_MS = 30000;

// ---------------------------------------------------------------------------
// Evidence weights (ints; deterministic sums, no float noise).
// Calibrated so a plain cross-provider pair (title + artists + duration +
// version, no ISRC/album) lands in `strong`, while folded-title or partial
// evidence lands in `possible`. `exact` requires ISRC or same-source id.
// ---------------------------------------------------------------------------
export const WEIGHT_ISRC_EXACT = 50;
export const WEIGHT_ISRC_CONFLICT = -40;
export const WEIGHT_TITLE_EXACT = 30;
export const WEIGHT_TITLE_CLOSE = 15;
export const WEIGHT_TITLE_MISMATCH = -35;
export const WEIGHT_ARTISTS_FULL = 25;
export const WEIGHT_ARTISTS_PARTIAL = 10;
export const WEIGHT_ARTISTS_CONFLICT = -30;
export const WEIGHT_DURATION_STRONG = 10;
export const WEIGHT_DURATION_CLOSE = 4;
export const WEIGHT_DURATION_MODERATE = -5;
export const WEIGHT_DURATION_LARGE = -20;
export const WEIGHT_ALBUM_SAME = 5;
export const WEIGHT_ALBUM_DIFFERENT = -3;
export const WEIGHT_VERSION_SAME = 5;
export const WEIGHT_REMASTER_ASYMMETRY = -8;
export const WEIGHT_UNKNOWN_MARKER_ASYMMETRY = -5;
export const WEIGHT_EXPLICIT_MISMATCH = -3;

export const SCORE_SAME_SOURCE = 120;
export const MATCH_THRESHOLD_EXACT = 100;
export const MATCH_THRESHOLD_STRONG = 60;
export const MATCH_THRESHOLD_POSSIBLE = 30;

export type MatchClassification = "exact" | "strong" | "possible" | "rejected";

export type MatchSignal =
  | "same-source-id"
  | "isrc"
  | "title"
  | "artists"
  | "duration"
  | "album"
  | "version"
  | "explicit";

export type MatchEvidenceResult = "positive" | "negative" | "neutral";

export interface MatchEvidence {
  signal: MatchSignal;
  result: MatchEvidenceResult;
  weight: number;
  detail?: string;
}

export type MatchRejectionReason =
  | "title-mismatch"
  | "artist-mismatch"
  | "duration-mismatch"
  | "version-mismatch"
  | "isrc-conflict"
  | "insufficient-evidence";

export interface TrackMatchResult {
  matched: boolean;
  classification: MatchClassification;
  /** Matcher-internal similarity sum. Evidence strength, not identity proof. */
  score: number;
  /** Fixed signal order; identical for (A,B) and (B,A). */
  evidence: MatchEvidence[];
  rejectionReasons: MatchRejectionReason[];
}

export interface TrackMatcher {
  match(left: TrackIdentity, right: TrackIdentity): TrackMatchResult;
}

export interface RankedCandidate {
  candidate: TrackIdentity;
  result: TrackMatchResult;
}

function sourceKeys(identity: TrackIdentity): Set<string> {
  return new Set(identity.sources.map((source) => sourceReferenceKey(source)));
}

function artistNameSet(identity: TrackIdentity, folded: boolean): Set<string> {
  const names = new Set<string>();
  for (const artist of identity.artists) {
    const normalized = normalizeArtistName(artist.name);
    if (normalized.length === 0) {
      continue;
    }
    names.add(folded ? foldDiacritics(normalized) : normalized);
  }
  return names;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function setsOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

type DurationVerdict = "strong" | "close" | "moderate" | "large" | "unknown";

function compareDurations(
  leftMs: number | undefined,
  rightMs: number | undefined,
): { verdict: DurationVerdict; diffMs: number | null } {
  if (leftMs === undefined || rightMs === undefined) {
    return { verdict: "unknown", diffMs: null };
  }
  const diffMs = Math.abs(leftMs - rightMs);
  if (diffMs <= DURATION_STRONG_MS) {
    return { verdict: "strong", diffMs };
  }
  const longer = Math.max(leftMs, rightMs);
  const closeLimit = Math.min(
    Math.max(DURATION_CLOSE_MS, longer * DURATION_CLOSE_REL_RATIO),
    DURATION_CLOSE_REL_CAP_MS,
  );
  if (diffMs <= closeLimit) {
    return { verdict: "close", diffMs };
  }
  const largeLimit = Math.max(DURATION_LARGE_MS, longer * 0.1);
  if (diffMs <= largeLimit) {
    return { verdict: "moderate", diffMs };
  }
  return { verdict: "large", diffMs };
}

function explicitOf(identity: TrackIdentity): boolean | null {
  const value = identity.metadata?.explicit;
  return typeof value === "boolean" ? value : null;
}

export function createTrackMatcher(): TrackMatcher {
  return {
    match(left: TrackIdentity, right: TrackIdentity): TrackMatchResult {
      const evidence: MatchEvidence[] = [];
      const rejectionReasons: MatchRejectionReason[] = [];
      const reject = (reason: MatchRejectionReason): void => {
        if (!rejectionReasons.includes(reason)) {
          rejectionReasons.push(reason);
        }
      };

      // Exact source identity shortcut (provider-scoped: youtube:123 never
      // equals spotify:123 because keys include the source).
      const shared = [...sourceKeys(left)].filter((key) => sourceKeys(right).has(key));
      if (shared.length > 0) {
        return {
          matched: true,
          classification: "exact",
          score: SCORE_SAME_SOURCE,
          evidence: [
            {
              signal: "same-source-id",
              result: "positive",
              weight: SCORE_SAME_SOURCE,
              detail: [...shared].sort().join(", "),
            },
          ],
          rejectionReasons: [],
        };
      }

      // ISRC: strongest cross-provider signal, never invented here.
      const leftIsrcs = identityIsrcs(left.sources);
      const rightIsrcs = identityIsrcs(right.sources);
      let score = 0;
      if (leftIsrcs.size > 0 && rightIsrcs.size > 0) {
        if (setsOverlap(leftIsrcs, rightIsrcs)) {
          score += WEIGHT_ISRC_EXACT;
          evidence.push({ signal: "isrc", result: "positive", weight: WEIGHT_ISRC_EXACT });
        } else {
          // Conflict lowers confidence materially but never hard-rejects:
          // remasters/reissues can legitimately carry different ISRCs. The
          // reason is recorded even when the pair still matches — reasons
          // list contradiction findings, not only fatal ones.
          score += WEIGHT_ISRC_CONFLICT;
          evidence.push({ signal: "isrc", result: "negative", weight: WEIGHT_ISRC_CONFLICT });
          reject("isrc-conflict");
        }
      } else {
        evidence.push({ signal: "isrc", result: "neutral", weight: 0 });
      }

      // Title: normalized base equality, folded closeness, else token check.
      const leftTitle = parseTitleVersion(left.title);
      const rightTitle = parseTitleVersion(right.title);
      if (leftTitle.base.length > 0 && leftTitle.base === rightTitle.base) {
        score += WEIGHT_TITLE_EXACT;
        evidence.push({ signal: "title", result: "positive", weight: WEIGHT_TITLE_EXACT });
      } else if (
        leftTitle.base.length > 0 &&
        foldDiacritics(leftTitle.base) === foldDiacritics(rightTitle.base)
      ) {
        score += WEIGHT_TITLE_CLOSE;
        evidence.push({ signal: "title", result: "positive", weight: WEIGHT_TITLE_CLOSE });
      } else {
        score += WEIGHT_TITLE_MISMATCH;
        evidence.push({ signal: "title", result: "negative", weight: WEIGHT_TITLE_MISMATCH });
        // Hard reject only when titles share NO token at all: "Song Alpha"
        // vs "Completely Different Song" still scores its way out via
        // artists, but "Alpha" vs "Beta" cannot.
        const overlap = tokenOverlap(tokenize(leftTitle.base), tokenize(rightTitle.base));
        if (overlap === 0) {
          reject("title-mismatch");
        }
      }

      // Artists: full canonical arrays, order-insensitive.
      const leftNames = artistNameSet(left, false);
      const rightNames = artistNameSet(right, false);
      if (leftNames.size === 0 || rightNames.size === 0) {
        evidence.push({ signal: "artists", result: "neutral", weight: 0 });
      } else if (setsEqual(leftNames, rightNames)) {
        score += WEIGHT_ARTISTS_FULL;
        evidence.push({ signal: "artists", result: "positive", weight: WEIGHT_ARTISTS_FULL });
      } else if (
        setsOverlap(leftNames, rightNames) ||
        setsOverlap(artistNameSet(left, true), artistNameSet(right, true))
      ) {
        score += WEIGHT_ARTISTS_PARTIAL;
        evidence.push({ signal: "artists", result: "positive", weight: WEIGHT_ARTISTS_PARTIAL });
      } else {
        score += WEIGHT_ARTISTS_CONFLICT;
        evidence.push({ signal: "artists", result: "negative", weight: WEIGHT_ARTISTS_CONFLICT });
        reject("artist-mismatch");
      }

      // Duration: supporting signal; unknown is neutral, never a mismatch.
      const duration = compareDurations(left.durationMs, right.durationMs);
      if (duration.verdict === "strong") {
        score += WEIGHT_DURATION_STRONG;
        evidence.push({ signal: "duration", result: "positive", weight: WEIGHT_DURATION_STRONG });
      } else if (duration.verdict === "close") {
        score += WEIGHT_DURATION_CLOSE;
        evidence.push({ signal: "duration", result: "positive", weight: WEIGHT_DURATION_CLOSE });
      } else if (duration.verdict === "moderate") {
        score += WEIGHT_DURATION_MODERATE;
        evidence.push({ signal: "duration", result: "negative", weight: WEIGHT_DURATION_MODERATE });
      } else if (duration.verdict === "large") {
        score += WEIGHT_DURATION_LARGE;
        evidence.push({ signal: "duration", result: "negative", weight: WEIGHT_DURATION_LARGE });
      } else {
        evidence.push({ signal: "duration", result: "neutral", weight: 0 });
      }
      if (duration.diffMs !== null && duration.diffMs > DURATION_HARD_REJECT_MS) {
        reject("duration-mismatch");
      }

      // Album: supporting evidence only. Same normalized title helps a
      // little; different albums (single vs LP vs compilation) never reject.
      const leftAlbum = left.album ? normalizeBase(left.album.title) : "";
      const rightAlbum = right.album ? normalizeBase(right.album.title) : "";
      if (leftAlbum.length === 0 || rightAlbum.length === 0) {
        evidence.push({ signal: "album", result: "neutral", weight: 0 });
      } else if (leftAlbum === rightAlbum) {
        score += WEIGHT_ALBUM_SAME;
        evidence.push({ signal: "album", result: "positive", weight: WEIGHT_ALBUM_SAME });
      } else {
        score += WEIGHT_ALBUM_DIFFERENT;
        evidence.push({ signal: "album", result: "negative", weight: WEIGHT_ALBUM_DIFFERENT });
      }

      // Version semantics: contradictions reject regardless of score.
      const versions = compareVersions(leftTitle, rightTitle);
      if (!versions.compatible) {
        // Order-independent detail so match(A,B) equals match(B,A).
        const sides = [
          leftTitle.kinds.join("+") || "standard",
          rightTitle.kinds.join("+") || "standard",
        ].sort();
        evidence.push({
          signal: "version",
          result: "negative",
          weight: 0,
          detail: sides.join(" vs "),
        });
        reject("version-mismatch");
      } else if (versions.sameKind) {
        score += WEIGHT_VERSION_SAME;
        evidence.push({ signal: "version", result: "positive", weight: WEIGHT_VERSION_SAME });
      } else {
        let adjustment = 0;
        if (versions.remasterAsymmetry) {
          adjustment += WEIGHT_REMASTER_ASYMMETRY;
        }
        if (versions.unknownAsymmetry) {
          adjustment += WEIGHT_UNKNOWN_MARKER_ASYMMETRY;
        }
        score += adjustment;
        evidence.push({
          signal: "version",
          result: adjustment === 0 ? "neutral" : "negative",
          weight: adjustment,
        });
      }

      // Explicit: weak supporting signal only, never a rejection.
      const leftExplicit = explicitOf(left);
      const rightExplicit = explicitOf(right);
      if (leftExplicit === null || rightExplicit === null) {
        evidence.push({ signal: "explicit", result: "neutral", weight: 0 });
      } else if (leftExplicit === rightExplicit) {
        evidence.push({ signal: "explicit", result: "neutral", weight: 0 });
      } else {
        score += WEIGHT_EXPLICIT_MISMATCH;
        evidence.push({ signal: "explicit", result: "negative", weight: WEIGHT_EXPLICIT_MISMATCH });
      }

      if (rejectionReasons.length > 0) {
        return { matched: false, classification: "rejected", score, evidence, rejectionReasons };
      }
      if (score >= MATCH_THRESHOLD_EXACT) {
        return { matched: true, classification: "exact", score, evidence, rejectionReasons };
      }
      if (score >= MATCH_THRESHOLD_STRONG) {
        return { matched: true, classification: "strong", score, evidence, rejectionReasons };
      }
      if (score >= MATCH_THRESHOLD_POSSIBLE) {
        return { matched: true, classification: "possible", score, evidence, rejectionReasons };
      }
      reject("insufficient-evidence");
      return { matched: false, classification: "rejected", score, evidence, rejectionReasons };
    },
  };
}

/**
 * Ranks candidates by matcher score (descending, input order breaks ties)
 * without mutating anything. Pure technical-similarity ordering: not a
 * playback or provider decision.
 */
export function rankMatches(
  source: TrackIdentity,
  candidates: TrackIdentity[],
  matcher: TrackMatcher = createTrackMatcher(),
): RankedCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, result: matcher.match(source, candidate), index }))
    .sort((a, b) => b.result.score - a.result.score || a.index - b.index)
    .map(({ candidate, result }) => ({ candidate, result }));
}

/**
 * Returns the best matched candidate (or null when every candidate is
 * rejected). Never merges identities, never chooses playback.
 */
export function findBestMatch(
  source: TrackIdentity,
  candidates: TrackIdentity[],
  matcher: TrackMatcher = createTrackMatcher(),
): RankedCandidate | null {
  for (const ranked of rankMatches(source, candidates, matcher)) {
    if (ranked.result.matched) {
      return ranked;
    }
  }
  return null;
}
