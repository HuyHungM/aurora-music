import type { Track } from "@/lib/domain";
import { trackKey } from "./identity";
import {
  PLAYBACK_CHECKPOINT_INTERVAL_MS,
  PLAYBACK_POSITION_THRESHOLD_S,
} from "./persistence-constants";

export type PersistenceInitState = "idle" | "loading" | "ready";

export interface PlaybackStatePayload {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
  updatedAt: string;
}

export interface SaveCheckpointInput {
  provider: string;
  providerTrackId: string;
  position: number;
  revision: number;
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
  };
  applyRestore: (track: Track, position: number) => void;
  setInitState: (state: PersistenceInitState) => void;
}

function normalizePosition(position: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.max(0, Math.floor(position));
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
 * Responsibilities: startup restore with user-intent race protection,
 * periodic/pause/track-change checkpoints with revision-based stale-write
 * protection, and cleanup on sign-out/unmount/account-switch.
 *
 * Invariants:
 * - USER INTENT > RESTORE (generation check discards stale restores)
 * - NEWER SAVE > OLDER SAVE (server-side revision CAS)
 * - CURRENT USER > STALE USER (operation snapshots capture userId)
 * - PROVIDER > PERSISTED METADATA (tracks always re-resolved)
 * - PLAYBACK > PERSISTENCE FAILURE (all errors are non-fatal)
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

  constructor(deps: PersistenceControllerDeps) {
    this.deps = deps;
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

  /** Explicit user action notification (currently informational; the store
   * generation is the source of truth for restore invalidation). */
  notifyUserAction(): void {
    // No-op by design: restore invalidation reads userActionGeneration
    // from the store snapshot, so no controller-side bookkeeping is needed.
  }

  notifyTrackChanged(oldTrack: Track | null, oldPosition: number): void {
    if (!this.ready || !this.userId || this.disposed) return;
    if (!oldTrack) return;
    void this.saveCheckpoint(oldTrack, normalizePosition(oldPosition));
  }

  notifyPaused(track: Track | null, position: number): void {
    if (!this.ready || !this.userId || this.disposed) return;
    if (!track) return;
    void this.saveCheckpoint(track, normalizePosition(position));
  }

  shutdown(): void {
    this.stopTimer();
    this.ready = false;
    this.userId = null;
    this.lastPersistedPosition = null;
    this.lastPersistedTrackKey = null;
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

  private async saveCheckpoint(
    track: Track,
    position: number,
  ): Promise<void> {
    const userId = this.userId;
    if (!userId || this.disposed) return;
    // Immutable operation snapshot: never read mutable store state after
    // this point, so async work cannot misattribute the position.
    const snapshot: SaveCheckpointInput = {
      provider: track.provider,
      providerTrackId: providerTrackIdOf(track),
      position: normalizePosition(position),
      revision: this.localRevision,
    };
    try {
      const result = await this.deps.savePlaybackStateAction(snapshot);
      if (this.disposed || this.userId !== userId) return;
      if (result.ok && !result.stale) {
        this.localRevision += 1;
        this.lastPersistedPosition = snapshot.position;
        this.lastPersistedTrackKey = trackIdentity(track);
      } else if (result.ok && result.stale) {
        await this.syncRevision(userId);
      }
    } catch {
      // Persistence failures never break playback.
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
