/**
 * Canonical duplicate detection over logical tracks.
 *
 * This module is a THIN policy layer, not a second identity system. It owns
 * exactly two decisions — "are these two representations one logical track?"
 * and "which of these collection entries survive?" — and it answers them
 * using only the existing canonical pieces:
 *
 * ```text
 *   Track | TrackIdentity
 *          ↓
 *   toTrackIdentity()   (existing normalizer — canonicalization)
 *          ↓
 *   identityKeys()      (existing identity — every addressable `source:id`)
 *          ↓
 *   TrackMatcher.match() (existing matcher — deterministic equivalence)
 *          ↓
 *   AUTO_MERGE_CLASSIFICATIONS (existing policy — exact | strong only)
 *          ↓
 *   duplicate decision
 * ```
 *
 * It deliberately does NOT:
 * - invent a new key format (`source:id`, from `sourceReferenceKey`, only);
 * - re-tune any matcher threshold or evidence weight;
 * - merge, rewrite or drop source references on anything it returns;
 * - reach the network, the database, or the player.
 *
 * WHY A SHARED MODULE AT ALL. Three user-facing collections (playlist
 * membership, the active queue, recently played) each had to answer the same
 * question, and each had grown its own ad-hoc answer. Search grouping merged
 * references instead of rejecting, recommendations compared bare key strings
 * and never considered cross-provider equivalence at all. Rather than let a
 * fourth copy appear, all of them read this one.
 *
 * TWO TIERS, IN THIS ORDER, ALWAYS:
 * 1. EXACT KEY OVERLAP. A `Set<string>` of `source:id` keys. This is the O(1)
 *    hot path and it is what catches the overwhelmingly common cases: the
 *    same provider resource added twice, a merged search group re-added, and
 *    a source reference that a group already carries in `metadata.sources`.
 * 2. MATCHER EQUIVALENCE. Only for candidates that miss tier 1. An
 *    `exact`/`strong` verdict means the same logical song from two providers
 *    (the Spotify and Deezer renderings of one recording). `possible` and
 *    `rejected` are NOT duplicates.
 *
 * COMPLEXITY. Tier 1 is O(1) per candidate against an index. Tier 2 is O(n)
 * matcher evaluations per candidate that misses tier 1, and the matcher is
 * pure string work with no allocation beyond its evidence array. Building the
 * index is O(n). A queue or playlist of a few hundred entries therefore costs
 * a few hundred cheap comparisons per mutation, and mutations are user
 * gestures (the write paths are additionally rate limited). This is the same
 * order of work `unified-search` already performs per search, and no
 * artificial cap is applied: a cap would make the result depend on position
 * in a way no caller could reason about.
 *
 * NO EXTERNAL CALLS. Detection never resolves a playback URL, never calls a
 * provider, and never touches the database. A temporary playback URL is
 * ephemeral by design and can never become an identity key.
 *
 * FAIL-OPEN ON UNCANONICALIZABLE INPUT. A track with no stable provider id,
 * title or artist cannot produce keys or an identity. Such an item is never
 * reported as a duplicate of anything and is always kept, so a collection is
 * never silently shortened because one entry was malformed. This mirrors
 * `queue-manager`'s "alignment over purity" rule.
 */

import type { Track } from "./track";
import type { SourceReference } from "./source-reference";
import { isSourceType, sourceReferenceKey } from "./source-reference";
import type { TrackIdentity } from "./track-identity";
import { identityKeys } from "./track-identity";
import { mergeSourceReference, toTrackIdentity } from "./track-normalizer";
import { parseTitleVersion, tokenize } from "./match-text";
import type { MatchClassification, TrackMatcher } from "./track-matcher";
import {
  AUTO_MERGE_CLASSIFICATIONS,
  createTrackMatcher,
  isAutoMergeable,
} from "./track-matcher";

/** Either shape the product stores a track in. */
export type CanonicalTrackLike = Track | TrackIdentity;

function isTrackIdentity(track: CanonicalTrackLike): track is TrackIdentity {
  return Array.isArray((track as Partial<TrackIdentity>).sources);
}

/**
 * Every `source:id` key a track can be addressed by.
 *
 * For an identity that is `identityKeys(identity)` — the merged source list,
 * not just the primary. For a provider row it is the row's own provider
 * identity plus every well-formed reference carried in `metadata.sources`,
 * which is where `identityToTrack` parks a merged group's full source list.
 *
 * A key set may be a strict superset of what `canonicalIdentityOf` can
 * reconstruct, because keys accept any non-empty `source`/`id` string pair
 * while identity merging only accepts known source types. That direction is
 * the safe one: a key can only ever find MORE duplicates, never fewer.
 */
export function canonicalTrackKeys(track: CanonicalTrackLike): string[] {
  if (isTrackIdentity(track)) {
    return [...identityKeys(track)];
  }
  const row = track;
  const primary = `${row.provider}:${row.providerTrackId ?? row.id}`;
  const keys = [primary];
  const carried = row.metadata?.sources;
  if (Array.isArray(carried)) {
    for (const source of carried) {
      const key = carriedSourceKey(source);
      if (key && !keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * A carried reference's key, or null when it is not a usable reference.
 *
 * Both halves must be non-empty strings. A `{ source: "deezer" }` with no id
 * is a half-written reference, and a `{ source, id: "" }` is not a provider
 * resource at all - emitting `deezer:` for either would register a key that
 * can never identify a real track, and would let two DIFFERENT malformed
 * entries collide on it.
 */
function carriedSourceKey(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { source, id } = value as { source?: unknown; id?: unknown };
  if (typeof source !== "string" || source.length === 0) {
    return null;
  }
  if (typeof id !== "string" || id.length === 0) {
    return null;
  }
  return `${source}:${id}`;
}

/**
 * The canonical identity of a track, or `null` when it cannot canonicalize.
 *
 * For a provider row carrying merged references in `metadata.sources`, those
 * references are merged into the identity (through the existing
 * `mergeSourceReference`) so the matcher sees the whole logical group rather
 * than only its primary. That is preservation, not invention: the references
 * were merged by an explicit earlier decision, and this only re-reads them.
 * References naming an unknown provider are skipped — `mergeSourceReference`
 * rejects them, and skipping keeps this a pure function.
 */
export function canonicalIdentityOf(track: CanonicalTrackLike): TrackIdentity | null {
  if (isTrackIdentity(track)) {
    return track;
  }
  const row = track;
  const base = tryNormalize(row);
  if (!base) {
    return null;
  }
  const carried = row.metadata?.sources;
  if (!Array.isArray(carried)) {
    return base;
  }
  let current = base;
  for (const raw of carried) {
    const reference = carriedReference(raw);
    if (!reference) {
      continue;
    }
    try {
      current = mergeSourceReference(current, reference);
    } catch {
      // A malformed carried reference never invalidates the identity.
    }
  }
  return current;
}

/**
 * A carried reference this identity can merge, or null.
 *
 * Stricter than `carriedSourceKey`: `mergeSourceReference` accepts only the
 * three production source types, so a key may exist for a reference the
 * identity cannot hold. Keeping the key is safe (it can only find more
 * duplicates); merging an unknown source is not possible, so it is skipped.
 */
function carriedReference(value: unknown): SourceReference | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { source, id } = value as { source?: unknown; id?: unknown };
  if (!isSourceType(source) || typeof id !== "string" || id.length === 0) {
    return null;
  }
  return { source, id };
}

function tryNormalize(track: Track): TrackIdentity | null {
  try {
    return toTrackIdentity(track);
  } catch {
    return null;
  }
}

/** How a duplicate was recognised. Recorded so callers can log the reason. */
export type DuplicateReason = "exact-key" | "matcher";

export interface CanonicalDuplicate {
  /** Index of the surviving entry in the collection that was searched. */
  index: number;
  /** The canonical key that matched, when the reason is `exact-key`. */
  key: string | null;
  reason: DuplicateReason;
  /** Present for `matcher` hits: the matcher's own classification. */
  classification: MatchClassification | null;
}

export interface CanonicalDuplicateOptions {
  /** Injected matcher. Defaults to the calibrated one. Never re-tuned here. */
  matcher?: TrackMatcher;
}

/**
 * A reusable duplicate index over a collection.
 *
 * Built once, queried many times. The key map is the O(1) tier — it holds both
 * membership and the surviving index, so an exact hit never needs a scan. The
 * identity list backs the matcher tier and is consulted only on a tier-1
 * miss. Callers that grow a collection should `add()` incrementally rather
 * than rebuild, which is what keeps an append amortised O(1).
 */
export class CanonicalDuplicateIndex {
  /** `source:id` -> index of the FIRST survivor that claimed it. */
  readonly #keys: Map<string, number>;
  /**
   * Normalized TITLE TOKEN -> survivor indexes holding it, ascending.
   *
   * This is a PREFILTER for tier 2, not a second matcher and not a second
   * dedupe policy: it can only ever narrow the candidates tier 2 would have
   * considered. See `#titleTokensOf` for why that is sound.
   */
  readonly #titlePostings: Map<string, number[]>;
  readonly #identities: (TrackIdentity | null)[];
  readonly #matcher: TrackMatcher;
  /** Identity conversions memoized by object reference. */
  readonly #identityCache: Map<CanonicalTrackLike, TrackIdentity | null>;
  /** Title-token extraction memoized by object reference. */
  readonly #titleTokenCache: Map<CanonicalTrackLike, string[]>;

  constructor(items: readonly CanonicalTrackLike[] = [], options: CanonicalDuplicateOptions = {}) {
    this.#keys = new Map<string, number>();
    this.#titlePostings = new Map();
    this.#identities = [];
    this.#matcher = options.matcher ?? createTrackMatcher();
    this.#identityCache = new Map();
    this.#titleTokenCache = new Map();
    for (const item of items) {
      this.add(item);
    }
  }

  get size(): number {
    return this.#identities.length;
  }

  #identityOf(track: CanonicalTrackLike): TrackIdentity | null {
    const cached = this.#identityCache.get(track);
    if (cached !== undefined) {
      return cached;
    }
    const identity = canonicalIdentityOf(track);
    this.#identityCache.set(track, identity);
    return identity;
  }

  /**
   * The normalized title tokens this entry is findable under.
   *
   * Memoized by object reference, like `#identityOf`, because `add` and `find`
   * both need it and `add` is called once per survivor.
   */
  #titleTokensOf(track: CanonicalTrackLike): string[] {
    const cached = this.#titleTokenCache.get(track);
    if (cached !== undefined) {
      return cached;
    }
    const identity = this.#identityOf(track);
    const tokens = identity
      ? [...tokenize(parseTitleVersion(identity.title).base)]
      : [];
    this.#titleTokenCache.set(track, tokens);
    return tokens;
  }

  /**
   * Survivor indexes that could possibly match `track`, ascending.
   *
   * WHY THIS IS SOUND, and why it is not a second dedupe policy. `match()`
   * hard-rejects a pair as `title-mismatch` when
   * `tokenOverlap(tokenize(leftBase), tokenize(rightBase)) === 0`
   * (`track-matcher.ts:288-291`), and a recorded rejection makes the match
   * `matched: false` (`:395-396`). So a pair can only be auto-mergeable if the
   * two titles share at least one token — which makes the union of the
   * candidate's title-token postings a SUPERSET of every mergeable survivor.
   * Scanning only that set can therefore skip pairs the matcher would have
   * rejected anyway, and cannot skip one it would have accepted.
   *
   * The exact-source shortcut in `match()` needs no carve-out: tier 1 derives
   * its keys from the same `identity.sources` the shortcut reads
   * (`canonicalTrackKeys` -> `identityKeys` for an identity), so any pair that
   * shortcut would accept has already been found by tier 1.
   *
   * An entry with NO title tokens is registered under none. That is exact, not
   * an approximation: with an empty base, `tokenOverlap` against any other base
   * is 0, so the matcher rejects the pair — including against another
   * empty-base entry.
   */
  #candidatesFor(track: CanonicalTrackLike): number[] {
    const tokens = this.#titleTokensOf(track);
    if (tokens.length === 0) {
      return [];
    }
    const seen = new Set<number>();
    for (const token of tokens) {
      const posting = this.#titlePostings.get(token);
      if (!posting) {
        continue;
      }
      for (const index of posting) {
        seen.add(index);
      }
    }
    // Ascending, because tier 2 must return the FIRST matching survivor and the
    // postings alone would not preserve that order across tokens.
    return [...seen].sort((a, b) => a - b);
  }

  /** Registers an entry as a survivor. Never re-checks it against itself. */
  add(track: CanonicalTrackLike): void {
    const index = this.#identities.length;
    for (const key of canonicalTrackKeys(track)) {
      if (!this.#keys.has(key)) {
        this.#keys.set(key, index);
      }
    }
    for (const token of this.#titleTokensOf(track)) {
      const posting = this.#titlePostings.get(token);
      if (posting) {
        posting.push(index);
      } else {
        this.#titlePostings.set(token, [index]);
      }
    }
    this.#identities.push(this.#identityOf(track));
  }

  /**
   * Finds the entry `track` duplicates, or `null`.
   *
   * Tier 1 is a map lookup. Tier 2 runs only on a miss and returns the FIRST
   * surviving entry that matches, in index order, so the result is
   * deterministic and does not depend on unrelated entries.
   */
  find(track: CanonicalTrackLike): CanonicalDuplicate | null {
    for (const key of canonicalTrackKeys(track)) {
      const index = this.#keys.get(key);
      if (index !== undefined) {
        return { index, key, reason: "exact-key", classification: null };
      }
    }
    const identity = this.#identityOf(track);
    if (!identity) {
      // Fail open: an uncanonicalizable track matches nothing.
      return null;
    }
    // Prefiltered: see `#candidatesFor`. This used to walk EVERY identity, so
    // a collection with no duplicates at all still paid one full matcher scan
    // per item — O(n²) matcher calls on the most common input there is.
    for (const index of this.#candidatesFor(track)) {
      const existing = this.#identities[index];
      if (!existing) {
        continue;
      }
      const result = this.#matcher.match(identity, existing);
      if (isAutoMergeable(result)) {
        return {
          index,
          key: null,
          reason: "matcher",
          classification: result.classification,
        };
      }
    }
    return null;
  }
}

/**
 * Collapses a collection to one entry per canonical track, keeping the FIRST
 * occurrence and preserving relative order.
 *
 * Uncanonicalizable entries are always kept (see the module doc comment), so
 * the result is never shorter than the count of items that could be
 * identified. `resolve` lets a caller holding positional references — a
 * `startIndex`, a persisted play-order cursor — re-point them at the surviving
 * entry instead of silently addressing the wrong slot. A dropped item resolves
 * to the survivor that absorbed it, so `resolve` is total: every input index
 * maps to a valid output index, and callers never need a -1 case.
 */
export function dedupeCanonicalTracks<T extends CanonicalTrackLike>(
  items: readonly T[],
  options: CanonicalDuplicateOptions = {},
): {
  kept: T[];
  /** Original index of each survivor, in survivor order. */
  keptIndices: number[];
  /** Input index -> survivor index. Total: every index has an entry. */
  resolve: number[];
  duplicates: CanonicalDuplicate[];
} {
  const index = new CanonicalDuplicateIndex([], options);
  const kept: T[] = [];
  const keptIndices: number[] = [];
  const resolve: number[] = new Array(items.length).fill(-1);
  const duplicates: CanonicalDuplicate[] = [];
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position] as T;
    const duplicate = index.find(item);
    if (duplicate) {
      const survivor = keptIndices[duplicate.index] as number;
      duplicates.push({ ...duplicate, index: survivor });
      resolve[position] = survivor;
      continue;
    }
    resolve[position] = kept.length;
    kept.push(item);
    keptIndices.push(position);
    index.add(item);
  }
  return { kept, keptIndices, resolve, duplicates };
}

/**
 * Single-item lookup against a collection, without building a reusable index.
 * Convenience for one-shot checks (a playlist membership test); prefer
 * `CanonicalDuplicateIndex` when checking many candidates against one
 * collection.
 */
export function findCanonicalDuplicate(
  candidate: CanonicalTrackLike,
  existing: readonly CanonicalTrackLike[],
  options: CanonicalDuplicateOptions = {},
): CanonicalDuplicate | null {
  return new CanonicalDuplicateIndex(existing, options).find(candidate);
}

export { AUTO_MERGE_CLASSIFICATIONS, isAutoMergeable, sourceReferenceKey };
