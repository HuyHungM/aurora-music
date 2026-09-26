import {
  isForeignLiveOwner,
  type PlaybackOwnership,
} from "@/lib/multi-tab/playback-ownership";

/**
 * The one mounted playback-ownership machine (mirrors the MusicEngine,
 * radio-session and continuation-coordinator lifecycle holders): one per
 * page load, owned by `PlaybackOwnershipHost`, cleared on unmount.
 *
 * ## Why the persistence controller needs this
 *
 * Phase 52 made one tab the audible owner across tabs, and its own module
 * comment names the half that was deliberately left open:
 *
 * > "because each tab also persists the session, whichever tab wrote last
 * > decides what the next page load restores."
 *
 * That is a real correctness gap, and it is not fixable inside the
 * ownership machine, because the machine knows nothing about persistence.
 * Every tab writes the *same* `PlaybackState` row — the row is scoped to
 * the user, not the tab — and the revision CAS only prevents two writes
 * landing simultaneously. A background tab that changes its queue after
 * being re-synced will win the next CAS and overwrite the session the user
 * is actually listening to.
 *
 * The fix is the smallest one that reuses the authority that already
 * exists: this tab stops persisting while a live foreign tab owns
 * playback. No second coordinator, no second queue, no second player — the
 * same machine that decides who is audible now also decides who owns the
 * persisted session, which is what "one authority per domain" means when
 * the domain is "which tab is the live listening session".
 *
 * Reads are lazy and total: with no machine mounted (server render, a test
 * that never mounts the host, or a browser without `BroadcastChannel`)
 * there is no foreign owner, so persistence behaves exactly as it did
 * before. That is the single-tab case, and it is the overwhelming majority
 * of real use.
 */

let current: PlaybackOwnership | null = null;

export function setPlaybackOwnership(machine: PlaybackOwnership | null): void {
  current = machine;
}

export function getPlaybackOwnership(): PlaybackOwnership | null {
  return current;
}

/**
 * Whether this tab should decline to write the playback session because a
 * live foreign tab owns playback. True only while another tab is audibly
 * playing; false whenever this tab is the owner, when nothing is playing,
 * and when cross-tab coordination is unavailable.
 */
export function isForeignPlaybackOwnerActive(): boolean {
  return current !== null && isForeignLiveOwner(current.getSnapshot());
}
