import type { Track, TrackIdentity } from "@/lib/domain";
import { canonicalTrackKeys } from "@/lib/domain";

/**
 * Queue identity helpers shared by radio (Phase 41) and generic
 * "Keep listening" continuation (Phase 47).
 *
 * Both coordinators need the same two answers: what keys does this queue
 * hold, and did the queue merely grow/shrink/reorder — or was it wholesale
 * REPLACED? Replacement is the signal that a human took over, and it is
 * what ends automatic continuation. Keeping one implementation means the
 * user-override rule cannot be right in one place and wrong in the other.
 *
 * KEY DERIVATION IS NOT REIMPLEMENTED HERE. `allKeysOf` delegates to
 * `canonicalTrackKeys`, the one domain-level definition of "every
 * `source:id` this track can be addressed by", so the coordinator's
 * already-queued check and the store's duplicate rejection can never
 * disagree about whether two queue entries are the same song.
 */

/** Primary canonical key of an identity or a plain track. */
export function identityKeyOf(track: TrackIdentity | Track): string {
  if (Array.isArray((track as Partial<TrackIdentity>).sources)) {
    const identity = track as TrackIdentity;
    return `${identity.primarySource.source}:${identity.primarySource.id}`;
  }
  const row = track as Track;
  return `${row.provider}:${row.providerTrackId ?? row.id}`;
}

/**
 * Every key a track can be addressed by, including source references
 * carried in metadata. Using one key only would let a cross-provider
 * duplicate back into a batch, because the queue entry and the
 * recommendation would name the same song with different sources.
 *
 * Thin delegation to the domain definition (`track-dedupe.ts`); kept as a
 * named export because radio and the listening coordinator both read it and
 * neither should have to know which module owns the key format.
 */
export function allKeysOf(track: TrackIdentity | Track): string[] {
  return canonicalTrackKeys(track);
}

function countsOf(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Multiset relationship between the expected and actual queue.
 *
 * Multiset rather than set, and deliberately still so. The queue itself now
 * holds one occurrence per canonical track (the store rejects a second one),
 * but a restored session or a caller-supplied signature can still present
 * repeated keys, and a relation that silently collapsed counts would then
 * report "same" for a queue that actually grew. Counting is the conservative
 * reading: it can only ever classify a change as more significant than it
 * really is, and over-signalling ends a continuation early rather than
 * letting one continue through a real change.
 *
 * This is a relation, NOT a deduplicator. It never collapses occurrences —
 * that is the store's job, and it is the only place that does it.
 */
export function relateQueues(
  expected: readonly string[],
  actual: readonly string[],
): "same" | "added" | "removed" | "replaced" {
  if (actual.length === 0) {
    return "replaced";
  }
  const expectedCounts = countsOf(expected);
  const actualCounts = countsOf(actual);
  let expectedCoversActual = true;
  for (const [key, count] of actualCounts) {
    if ((expectedCounts.get(key) ?? 0) < count) {
      expectedCoversActual = false;
      break;
    }
  }
  let actualCoversExpected = true;
  for (const [key, count] of expectedCounts) {
    if ((actualCounts.get(key) ?? 0) < count) {
      actualCoversExpected = false;
      break;
    }
  }
  if (expectedCoversActual && actualCoversExpected) {
    return "same";
  }
  if (expectedCoversActual) {
    return "removed";
  }
  if (actualCoversExpected) {
    return "added";
  }
  return "replaced";
}
