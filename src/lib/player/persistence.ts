import type { Track } from "@/lib/domain";
import { isOfflineTrack } from "@/lib/offline/isolation";
import { trackKey } from "./identity";
import {
  PLAYBACK_CHECKPOINT_INTERVAL_MS,
  PLAYBACK_POSITION_THRESHOLD_S,
} from "./persistence-constants";
import {
  QUEUE_SNAPSHOT_DEBOUNCE_MS,
  queueSnapshotContentKey,
  serializeQueueSnapshot,
  snapshotToTracks,
  validateQueueSnapshot,
  type PersistedQueueSnapshot,
} from "./queue-snapshot";

export type PersistenceInitState = "idle" | "loading" | "ready";

export interface PlaybackStatePayload {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
  updatedAt: string;
  /** Versioned queue snapshot when the row carries one (unknown until validated). */
  queueSnapshot?: unknown;
}

export interface SaveCheckpointInput {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
  queueSnapshot?: PersistedQueueSnapshot;
}

export interface QueueRestoreInput {
  tracks: Track[];
  playOrder: number[];
  position: number;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  mediaPosition: number;
  /** Provider-fresh current track; falls back to the snapshot entry. */
  currentTrack?: Track | null;
  /** Persisted player preferences (Phase 43); omitted means defaults. */
  volume?: number;
  muted?: boolean;
}

export interface PersistenceControllerDeps {
  getPlaybackStateAction: () => Promise<
    { ok: true; state: PlaybackStatePayload | null } | { ok: false }
  >;
  savePlaybackStateAction: (
    snapshot: SaveCheckpointInput,
  ) => Promise<{ ok: boolean; stale?: boolean }>;
  clearPlaybackStateAction: () => Promise<{ ok: boolean }>;
  resolveTrack: (
    provider: string,
    providerTrackId: string,
  ) => Promise<Track | null>;
  getStoreSnapshot: () => {
    currentTrack: Track | null;
    currentTime: number;
    isPlaying: boolean;
    userActionGeneration: number;
    queue: Track[];
    playOrder: number[];
    /** Cursor within playOrder. */
    position: number;
    shuffle: boolean;
    repeat: "off" | "all" | "one";
    volume: number;
    muted: boolean;
  };
  applyRestore: (track: Track, position: number) => void;
  /** Applies a validated queue snapshot as live QueueManager state. */
  applyQueueRestore: (restored: QueueRestoreInput) => void;
  setInitState: (state: PersistenceInitState) => void;
  /**
   * Whether this tab may write the session right now. False while a live
   * foreign tab owns playback (see `isForeignPlaybackOwnerActive`): the
   * queue in this tab is then a background session, and persisting it would
   * overwrite the session the user is actually listening to. Optional so a
   * caller with no multi-tab coordination keeps the pre-existing behaviour.
   */
  shouldPersistSession?: () => boolean;
}

function normalizePosition(position: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.max(0, Math.floor(position));
}

/**
 * Minimum jump (seconds) between consecutive store snapshots that counts
 * as an explicit seek rather than natural playback progress. Playback
 * `timeupdate` relay is throttled to 250ms, so natural deltas stay well
 * below this; a seek surfaces as a large discontinuity on the same track.
 */
export const SEEK_JUMP_DELTA_S = 1.5;

export function isSeekJump(previousTime: number, nextTime: number): boolean {
  if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime)) {
    return false;
  }
  return Math.abs(nextTime - previousTime) > SEEK_JUMP_DELTA_S;
}

function trackIdentity(track: Track): string {
  return trackKey(track);
}

function providerTrackIdOf(track: Track): string {
  return track.providerTrackId ?? track.id;
}

/**
 * Client-side lifecycle controller for authenticated playback persistence.
 *
 * Responsibilities: startup restore (full queue when a validated snapshot
 * exists, legacy single track otherwise) with user-intent race
 * protection, periodic/pause/track-change checkpoints plus debounced
 * queue-mutation snapshots, all with revision-based stale-write
 * protection, and cleanup on sign-out/unmount/account-switch.
 *
 * Invariants:
 * - USER INTENT > RESTORE (generation check discards stale restores)
 * - NEWER SAVE > OLDER SAVE (server-side revision CAS)
 * - CURRENT USER > STALE USER (operation snapshots capture userId)
 * - PROVIDER > PERSISTED METADATA (current track always re-resolved;
 *   queued tracks stay identity-only until played)
 * - PLAYBACK > PERSISTENCE FAILURE (all errors are non-fatal)
 * - Anonymous users: no persistence at all (browser storage is banned
 *   by the quality gates, so there is no approved client mechanism).
 */
export class PlaybackPersistenceController {
  private readonly deps: PersistenceControllerDeps;
  private restoreGeneration = 0;
  private localRevision = 0;
  private userId: string | null = null;
  private ready = false;
  private disposed = false;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private lastPersistedPosition: number | null = null;
  private lastPersistedTrackKey: string | null = null;
  private lastQueueKey: string | null = null;
  private queueSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The single persistence write lane.
   *
   * Every writer — the debounced queue write, the page-lifecycle flush, and
   * the track/pause checkpoint — persists the FULL queue snapshot plus the
   * cursor position under the same `revision` compare-and-swap. Two
   * concurrent writes therefore race, and the loser is told `stale` and has
   * its payload dropped by the server. That is not a harmless lost update:
   * the winner is whichever request reached the database first, so an
   * OLDER snapshot can win and durably revert a newer queue. This flag is
   * what makes the lane single: a writer that finds it set hands its request
   * to the pending slots below instead of issuing a competing write.
   */
  private writeInFlight = false;
  /**
   * A write request (debounced queue change or page-lifecycle flush) that
   * arrived while another write was in flight. Dropping it would lose the
   * user's change, so it re-arms once the in-flight write settles. The
   * debounce has already disarmed its timer by then, which is why the
   * re-arm flag — not the timer — is the only thing that can rescue it.
   *
   * Rebuilt from current state on retry, so this slot only needs to say
   * "something changed", not what it changed to.
   */
  private writeQueued = false;
  /**
   * A track/pause checkpoint that arrived while the lane was busy.
   *
   * Unlike `writeQueued` this one carries an OPERATION snapshot - the track
   * the user just left, and the position they left it at - which cannot be
   * rebuilt from current state, so it is kept verbatim. Only the newest is
   * retained: a superseded checkpoint describes a track the user has already
   * moved past, and the queue snapshot it would rebuild is the current one
   * anyway.
   */
  private pendingCheckpoint: {
    track: Track;
    position: number;
    /**
     * Whether this record has already been re-driven after losing a revision
     * CAS. The retry is worth exactly one attempt: a foreign writer that
     * keeps winning means this tab is not the live session, and spinning on
     * it would turn a lost cursor update into an unbounded request loop.
     *
     * The flag rides on the record rather than on the controller because the
     * two reasons a checkpoint parks are different — "the lane was busy"
     * (a fresh request, full budget) and "a CAS rejected it" (a re-drive,
     * budget already spent). A shared flag would be reset by the first and
     * never stop the second.
     */
    retried: boolean;
  } | null = null;

  constructor(deps: PersistenceControllerDeps) {
    this.deps = deps;
  }

  /**
   * Whether a write is allowed right now. Guards the whole write surface,
   * not just the two write methods, so a suppressed change also never arms
   * a timer that would only fire to decline.
   *
   * Suppression is not a queue: while a foreign tab owns playback this tab
   * simply is not the live session, and its state is written again by the
   * next change — or by the periodic checkpoint — as soon as it becomes the
   * live one. Deferring instead would mean holding a snapshot nobody asked
   * for and replaying it later, which is exactly the "stale tab overwrites
   * the newer session" behaviour this guards against.
   */
  private mayPersist(): boolean {
    return this.deps.shouldPersistSession?.() ?? true;
  }

  async initialize(userId: string | null): Promise<void> {
    // Idempotent: tear down any previous lifecycle before starting a new one.
    this.shutdown();
    this.disposed = false;
    this.userId = userId;

    // Anonymous users: no persistence, but mark ready so UI never waits.
    if (!userId) {
      this.ready = true;
      this.deps.setInitState("ready");
      return;
    }

    const myGeneration = ++this.restoreGeneration;
    const storeGenAtStart =
      this.deps.getStoreSnapshot().userActionGeneration;
    this.deps.setInitState("loading");

    try {
      const result = await this.deps.getPlaybackStateAction();
      if (this.disposed || myGeneration !== this.restoreGeneration) return;
      if (this.userId !== userId) return;
      if (!result.ok || !result.state) {
        this.finishInit(myGeneration, userId);
        return;
      }

      const snap = result.state;
      this.localRevision = snap.revision;

      // Preferred path: validated versioned queue snapshot.
      const queueSnapshot = validateQueueSnapshot(snap.queueSnapshot);
      if (queueSnapshot) {
        await this.restoreQueueSnapshot(queueSnapshot, myGeneration, userId, storeGenAtStart);
        return;
      }

      // Legacy path: single-track rows without a snapshot.
      if (
        typeof snap.provider !== "string" ||
        snap.provider.length === 0 ||
        typeof snap.providerTrackId !== "string" ||
        snap.providerTrackId.length === 0
      ) {
        await this.deps.clearPlaybackStateAction().catch(() => undefined);
        this.finishInit(myGeneration, userId);
        return;
      }

      const track = await this.deps.resolveTrack(
        snap.provider,
        snap.providerTrackId,
      );
      if (this.disposed || myGeneration !== this.restoreGeneration) return;
      if (this.userId !== userId) return;

      if (!track) {
        // Provider can no longer resolve the persisted track: discard it.
        await this.deps.clearPlaybackStateAction().catch(() => undefined);
        this.finishInit(myGeneration, userId);
        return;
      }

      // User intent wins: if the user acted while we were restoring, discard.
      const storeGenNow =
        this.deps.getStoreSnapshot().userActionGeneration;
      if (storeGenNow !== storeGenAtStart) {
        this.finishInit(myGeneration, userId);
        return;
      }

      const safePosition = normalizePosition(snap.position);
      this.deps.applyRestore(track, safePosition);
      this.lastPersistedPosition = safePosition;
      this.lastPersistedTrackKey = trackIdentity(track);
      this.finishInit(myGeneration, userId);
    } catch {
      // Restore failures are non-fatal; player continues anonymously.
      if (!this.disposed && myGeneration === this.restoreGeneration) {
        this.finishInit(myGeneration, userId);
      }
    }
  }

  /**
   * Restores a validated queue snapshot: the queue becomes live
   * QueueManager state (fully operable, never read-only). Only the
   * current entry is re-resolved through the provider; every other
   * entry stays identity-only until actually played — no URL is ever
   * pre-resolved or persisted.
   */
  private async restoreQueueSnapshot(
    queueSnapshot: PersistedQueueSnapshot,
    myGeneration: number,
    userId: string,
    storeGenAtStart: number,
  ): Promise<void> {
    const tracks = snapshotToTracks(queueSnapshot);
    let currentTrack: Track | null = null;
    let mediaPosition = 0;

    if (queueSnapshot.position >= 0 && tracks.length > 0) {
      const currentEntry =
        queueSnapshot.entries[
          queueSnapshot.playOrder[queueSnapshot.position] as number
        ];
      if (currentEntry) {
        // Provider-fresh metadata for the current track; a single
        // unresolvable current track never invalidates the queue.
        currentTrack = await this.deps.resolveTrack(
          currentEntry.provider,
          currentEntry.providerTrackId,
        );
        if (this.disposed || myGeneration !== this.restoreGeneration) return;
        if (this.userId !== userId) return;
        mediaPosition = currentTrack
          ? normalizePosition(queueSnapshot.mediaPosition)
          : 0;
        if (!currentTrack) {
          // Fall back to the snapshot entry so the queue keeps its
          // cursor; the engine reports the terminal error on play.
          currentTrack =
            tracks[queueSnapshot.playOrder[queueSnapshot.position] as number] ??
            null;
        }
      }
    }

    // User intent wins: if the user acted while we were restoring, discard.
    const storeGenNow = this.deps.getStoreSnapshot().userActionGeneration;
    if (storeGenNow !== storeGenAtStart) {
      this.finishInit(myGeneration, userId);
      return;
    }

    this.deps.applyQueueRestore({
      tracks,
      playOrder: queueSnapshot.playOrder,
      position: queueSnapshot.position,
      shuffle: queueSnapshot.shuffle,
      repeat: queueSnapshot.repeat,
      mediaPosition,
      currentTrack,
      volume: queueSnapshot.volume,
      muted: queueSnapshot.muted,
    });
    this.lastPersistedPosition = mediaPosition;
    this.lastPersistedTrackKey = currentTrack
      ? trackIdentity(currentTrack)
      : null;
    this.lastQueueKey = queueSnapshotContentKey(queueSnapshot);
    this.finishInit(myGeneration, userId);
  }

  /** Explicit user action notification (currently informational; the store
   * generation is the source of truth for restore invalidation). */
  notifyUserAction(): void {
    // No-op by design: restore invalidation reads userActionGeneration
    // from the store snapshot, so no controller-side bookkeeping is needed.
  }

  notifyTrackChanged(oldTrack: Track | null, oldPosition: number): void {
    if (!this.ready || !this.userId || this.disposed) return;
    if (!oldTrack) return;
    if (!this.mayPersist()) return;
    void this.saveCheckpoint(oldTrack, normalizePosition(oldPosition));
  }

  notifyPaused(track: Track | null, position: number): void {
    if (!this.ready || !this.userId || this.disposed) return;
    if (!track) return;
    if (!this.mayPersist()) return;
    void this.saveCheckpoint(track, normalizePosition(position));
  }

  /**
   * Player-preference notification (volume/mute). These live in the same
   * versioned session snapshot, so they share the existing debounced
   * write rather than adding a second persistence path. The PlayerHost
   * calls this only when volume or mute actually changes — dragging the
   * volume slider coalesces into one write.
   */
  notifyPreferencesChanged(): void {
    this.notifyQueueChanged();
  }

  /**
   * Queue-mutation notification (add/remove/move/clear/replace/shuffle/
   * repeat/navigation). Coalesced through a trailing one-shot debounce —
   * never a loop, never per-render. The PlayerHost calls this only when
   * queue/playOrder/position/shuffle/repeat actually change.
   */
  notifyQueueChanged(): void {
    if (!this.ready || !this.userId || this.disposed) return;
    if (!this.mayPersist()) return;
    if (this.queueSaveTimer !== null) {
      clearTimeout(this.queueSaveTimer);
    }
    this.queueSaveTimer = setTimeout(() => {
      this.queueSaveTimer = null;
      void this.saveQueueSnapshotNow();
    }, QUEUE_SNAPSHOT_DEBOUNCE_MS);
    const timer = this.queueSaveTimer as unknown as {
      unref?: () => void;
    };
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  /**
   * Best-effort flush for page-hide/visibility transitions. This is the
   * final safety layer only: the primary path is persist-on-change
   * (debounced queue snapshots + track/pause checkpoints), because an
   * in-flight request is not guaranteed to survive page teardown.
   */
  flushQueueSnapshot(): void {
    if (!this.ready || !this.userId || this.disposed) return;
    // A page-lifecycle flush is the last word on this tab's session. If
    // another tab is the live one, this tab's last word would be a stale
    // queue written over the user's actual listening session.
    if (!this.mayPersist()) return;
    if (this.queueSaveTimer !== null) {
      clearTimeout(this.queueSaveTimer);
      this.queueSaveTimer = null;
    }
    if (this.writeInFlight) {
      // Re-arm after the in-flight write instead of dropping the flush.
      this.writeQueued = true;
      return;
    }
    void this.saveQueueSnapshotNow();
  }

  shutdown(): void {
    this.stopTimer();
    if (this.queueSaveTimer !== null) {
      clearTimeout(this.queueSaveTimer);
      this.queueSaveTimer = null;
    }
    this.ready = false;
    this.userId = null;
    this.lastPersistedPosition = null;
    this.lastPersistedTrackKey = null;
    this.lastQueueKey = null;
    this.writeInFlight = false;
    this.writeQueued = false;
    this.pendingCheckpoint = null;
    this.disposed = true;
  }

  private finishInit(generation: number, userId: string): void {
    if (this.disposed || generation !== this.restoreGeneration) return;
    if (this.userId !== userId) return;
    this.ready = true;
    this.deps.setInitState("ready");
    this.startTimer();
  }

  private startTimer(): void {
    this.stopTimer();
    this.checkpointTimer = setInterval(() => {
      void this.maybeCheckpoint();
    }, PLAYBACK_CHECKPOINT_INTERVAL_MS);
    // Don't keep the process alive in non-browser runtimes.
    const timer = this.checkpointTimer as unknown as {
      unref?: () => void;
    };
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  private stopTimer(): void {
    if (this.checkpointTimer !== null) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = null;
    }
  }

  private async maybeCheckpoint(): Promise<void> {
    if (!this.ready || !this.userId || this.disposed) return;
    const snap = this.deps.getStoreSnapshot();
    const track = snap.currentTrack;
    if (!track) return;
    // Pause checkpoints cover the paused case; the timer only persists
    // while audio is actually playing to avoid redundant writes.
    if (!snap.isPlaying) return;
    const position = normalizePosition(snap.currentTime);
    const key = trackIdentity(track);
    if (
      this.lastPersistedPosition !== null &&
      this.lastPersistedTrackKey === key &&
      Math.abs(position - this.lastPersistedPosition) <=
        PLAYBACK_POSITION_THRESHOLD_S
    ) {
      return;
    }
    await this.saveCheckpoint(track, position);
  }

  private buildQueueSnapshot(): PersistedQueueSnapshot {
    const snap = this.deps.getStoreSnapshot();
    return serializeQueueSnapshot({
      queue: snap.queue,
      playOrder: snap.playOrder,
      position: snap.position,
      mediaPosition: snap.currentTime,
      shuffle: snap.shuffle,
      repeat: snap.repeat,
      volume: snap.volume,
      muted: snap.muted,
    });
  }

  /**
   * Persists the full queue snapshot. An empty queue deletes the row so
   * a cleared queue can never return after refresh; afterwards the
   * revision restarts at 0 (fresh-create semantics).
   */
  private async saveQueueSnapshotNow(): Promise<void> {
    const userId = this.userId;
    if (!userId || this.disposed) return;
    // Re-checked here, not only at the notify sites: a debounce or a
    // lifecycle flush can fire after this tab has already yielded, and the
    // re-armed write from a settled request lands here too.
    if (!this.mayPersist()) return;
    if (this.writeInFlight) {
      // The lane is busy. This call came from the debounced queue-change
      // path, which has *already* disarmed its timer, so returning here
      // silently discards the user's newest queue: the debounce will not
      // fire again, and no page-lifecycle flush is guaranteed to follow.
      // Re-arm instead — the in-flight write's `finally` drains this slot
      // back into this method, and it rebuilds the snapshot from current
      // state, so the retry carries the newest queue rather than a stale
      // one. Reachable whenever a server round trip outlasts
      // QUEUE_SNAPSHOT_DEBOUNCE_MS while the user keeps mutating the
      // queue, which is ordinary on a slow connection.
      this.writeQueued = true;
      return;
    }
    const queueSnapshot = this.buildQueueSnapshot();
    if (queueSnapshot.entries.length === 0) {
      try {
        await this.deps.clearPlaybackStateAction();
      } catch {
        // Persistence failures never break playback.
      }
      if (this.disposed || this.userId !== userId) return;
      this.localRevision = 0;
      this.lastPersistedPosition = null;
      this.lastPersistedTrackKey = null;
      this.lastQueueKey = queueSnapshotContentKey(queueSnapshot);
      return;
    }
    this.writeInFlight = true;
    try {
      const contentKey = queueSnapshotContentKey(queueSnapshot);
      if (this.lastQueueKey === contentKey) return;
      const store = this.deps.getStoreSnapshot();
      // Legacy columns mirror the current track for rows without a
      // snapshot reader; the snapshot itself is authoritative here.
      const cursorEntry =
        queueSnapshot.entries[
          queueSnapshot.playOrder[queueSnapshot.position] as number
        ];
      const currentIsPersistable =
        store.currentTrack !== null && !isOfflineTrack(store.currentTrack);
      const legacyRef = currentIsPersistable
        ? {
            provider: (store.currentTrack as Track).provider,
            providerTrackId: providerTrackIdOf(store.currentTrack as Track),
          }
        : cursorEntry
          ? {
              provider: cursorEntry.provider,
              providerTrackId: cursorEntry.providerTrackId,
            }
          : null;
      if (!legacyRef) return;
      const snapshot: SaveCheckpointInput = {
        provider: legacyRef.provider,
        providerTrackId: legacyRef.providerTrackId,
        position: normalizePosition(store.currentTime),
        revision: this.localRevision,
        queueSnapshot,
      };
      const result = await this.deps.savePlaybackStateAction(snapshot);
      if (this.disposed || this.userId !== userId) return;
      if (result.ok && !result.stale) {
        this.localRevision += 1;
        this.lastPersistedPosition = snapshot.position;
        this.lastPersistedTrackKey = store.currentTrack
          ? trackIdentity(store.currentTrack)
          : null;
        this.lastQueueKey = contentKey;
      } else if (result.ok && result.stale) {
        await this.syncRevision(userId);
      }
    } catch {
      // Persistence failures never break playback.
    } finally {
      this.writeInFlight = false;
      this.drainPendingWrite();
    }
  }

  /**
   * Re-arms the single write lane with whatever arrived while it was busy.
   *
   * Called from every writer's `finally`, so the lane is always handed
   * straight to the next request instead of waiting for a timer that may
   * never be armed again. The checkpoint is drained first because it is the
   * only pending slot carrying an operation snapshot; the rebuild-from-state
   * queue write behind it still runs, and its own content-key check is what
   * makes that a cheap no-op when the checkpoint already wrote the same
   * queue.
   */
  private drainPendingWrite(): void {
    const checkpoint = this.pendingCheckpoint;
    if (checkpoint) {
      this.pendingCheckpoint = null;
      void this.saveCheckpoint(checkpoint.track, checkpoint.position, checkpoint.retried);
      return;
    }
    if (this.writeQueued) {
      this.writeQueued = false;
      // The write that just finished was built before this request arrived,
      // so the state that triggered it is not in it yet.
      void this.saveQueueSnapshotNow();
    }
  }

  private async saveCheckpoint(
    track: Track,
    position: number,
    alreadyRetried = false,
  ): Promise<void> {
    const userId = this.userId;
    if (!userId || this.disposed) return;
    if (!this.mayPersist()) return;
    // Same single lane as the queue write, and for the same reason: both
    // persist the whole snapshot under one revision CAS, so a concurrent
    // checkpoint would race a concurrent queue write and let the older of
    // the two win durably. The retry rebuilds the queue snapshot from
    // current state, so only this operation's own arguments are carried.
    if (this.writeInFlight) {
      this.pendingCheckpoint = { track, position, retried: false };
      return;
    }
    // Immutable operation snapshot: never read mutable store state after
    // this point, so async work cannot misattribute the position.
    // Every checkpoint carries the current queue snapshot, so one
    // revision bump covers track + queue atomically.
    const queueSnapshot = this.buildQueueSnapshot();
    // An offline track must never reach these legacy columns. Its
    // `providerTrackId` is the track's folder-relative path, and this row is
    // the durable server-side session - so writing it would put the user's
    // local folder structure in the production database, which the queue
    // snapshot right beside it already refuses to do. Falls back to the
    // cursor entry, which is provider-backed by construction because
    // `serializeQueueSnapshot` drops local tracks.
    const cursorEntry =
      queueSnapshot.entries[
        queueSnapshot.playOrder[queueSnapshot.position] as number
      ];
    const ref = isOfflineTrack(track)
      ? cursorEntry
        ? {
            provider: cursorEntry.provider,
            providerTrackId: cursorEntry.providerTrackId,
          }
        : null
      : {
          provider: track.provider,
          providerTrackId: providerTrackIdOf(track),
        };
    if (!ref) return;
    const snapshot: SaveCheckpointInput = {
      provider: ref.provider,
      providerTrackId: ref.providerTrackId,
      position: normalizePosition(position),
      revision: this.localRevision,
      queueSnapshot,
    };
    this.writeInFlight = true;
    try {
      const result = await this.deps.savePlaybackStateAction(snapshot);
      if (this.disposed || this.userId !== userId) return;
      if (result.ok && !result.stale) {
        this.localRevision += 1;
        this.lastPersistedPosition = snapshot.position;
        this.lastPersistedTrackKey = trackIdentity(track);
        this.lastQueueKey = queueSnapshotContentKey(queueSnapshot);
      } else if (result.ok && result.stale) {
        // A foreign writer advanced the row first. Re-read the revision and
        // re-drive this exact checkpoint rather than dropping it: the cursor
        // position it records is not reconstructible from current state, so
        // discarding it would silently lose where the user left off.
        if (alreadyRetried) return;
        await this.syncRevision(userId);
        if (this.disposed || this.userId !== userId) return;
        this.pendingCheckpoint = { track, position, retried: true };
      }
    } catch {
      // Persistence failures never break playback.
    } finally {
      this.writeInFlight = false;
      this.drainPendingWrite();
    }
  }

  private async syncRevision(userId: string): Promise<void> {
    try {
      const result = await this.deps.getPlaybackStateAction();
      if (this.disposed || this.userId !== userId) return;
      if (result.ok && result.state) {
        this.localRevision = result.state.revision;
      }
    } catch {
      // Non-fatal.
    }
  }
}
