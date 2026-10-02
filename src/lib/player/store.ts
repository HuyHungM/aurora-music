import { create } from "zustand";
import type { Track } from "@/lib/domain";
import {
  CanonicalDuplicateIndex,
  dedupeCanonicalTracks,
} from "@/lib/domain";
import { PlayerEngine, PlayerError } from "./engine";
import type { PlayerErrorKind } from "./engine";
import { trackKey } from "./identity";
import { isQualifiedPlay } from "./qualification";
import type { PlaybackController } from "@/lib/playback/controller";

/** Server action for recording a qualified play. Injected by PlayerHost. */
let recordPlayedAction: ((track: Track) => Promise<{ ok: boolean }>) | null = null;

/**
 * PlaybackController bridge (Phase 10). When bound by PlayerHost, track
 * loads route through resolution; transport notifications keep controller
 * intent in sync. Null in tests and controller-less contexts, where the
 * store drives the engine directly exactly as before.
 */
let playbackController: PlaybackController | null = null;

export function setPlaybackController(
  controller: PlaybackController | null,
): void {
  playbackController = controller;
}

/**
 * Suppresses user-action generation counting while the persistence layer
 * applies a restore. A restore must never invalidate itself.
 */
let suppressUserActionCounting = false;

export type PersistenceInitState = "idle" | "loading" | "ready";

export function setRecordPlayedAction(
  action: (track: Track) => Promise<{ ok: boolean }>,
) {
  recordPlayedAction = action;
}

export type RepeatMode = "off" | "all" | "one";

export interface PlayerUiError {
  kind: PlayerErrorKind;
  message: string;
}

export interface PlayerTrackRef {
  provider: Track["provider"];
  id: string;
}

export interface ReplaceQueueOptions {
  startIndex?: number;
  autoplay?: boolean;
  preserveCurrent?: boolean;
}

interface PlayerState {
  currentTrack: Track | null;
  isPlaying: boolean;
  isLoading: boolean;
  error: PlayerUiError | null;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;

  queue: Track[];
  /** Indices into [queue] in playback sequence (shuffle reorders this list). */
  playOrder: number[];
  /** Current position within [playOrder]. */
  position: number;
  shuffle: boolean;
  repeat: RepeatMode;

  isQueueOpen: boolean;

  /** Track key of the current track that has already been reported as a qualified play. */
  qualifiedTrackKey: string | null;

  playTrack: (track: Track, options?: { autoplay?: boolean }) => void;
  replaceQueue: (tracks: Track[], options?: ReplaceQueueOptions) => void;
  playCollection: (tracks: Track[], startIndex?: number) => void;
  playNext: (track: Track) => void;
  addToQueue: (track: Track) => void;
  /**
   * Warms the resolution for a track without loading it: no queue change, no
   * engine call, no error surfacing. Used for the likely-next track and for
   * hover intent. Total fire-and-forget — failures vanish inside the
   * controller's prefetch slot logic.
   */
  prefetchTrack: (track: Track) => void;
  playAtPosition: (position: number) => void;
  togglePlay: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  /** Sets mute explicitly (restore path); toggleMute stays the UI action. */
  setMuted: (value: boolean) => void;
  clearError: () => void;
  /** Controller error sink: mirrors engine error state shape. Additive. */
  reportPlaybackError: (kind: PlayerErrorKind, message: string) => void;
  next: () => void;
  prev: () => void;
  clearQueue: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;

  /** Engine wiring: the PlayerHost mounts the single engine and binds it here. */
  bindEngine: (engine: PlayerEngine | null) => () => void;

  openQueue: () => void;
  closeQueue: () => void;
  removeFromQueue: (position: number) => void;
  moveQueueItem: (position: number, direction: "up" | "down") => void;

  isFullPlayerOpen: boolean;
  openFullPlayer: () => void;
  closeFullPlayer: () => void;

  /** Authenticated persistence lifecycle state (Phase 7D). */
  persistenceInitState: PersistenceInitState;
  setPersistenceInitState: (state: PersistenceInitState) => void;

  /**
   * Monotonic counter bumped by every explicit user playback action.
   * The persistence controller captures it at restore start and discards
   * the restore if it changed — user intent always beats restoration.
   */
  userActionGeneration: number;
  incrementUserActionGeneration: () => void;

  /**
   * Position (seconds) to seek to once the restored track's metadata loads.
   * Set by restoreTrack, consumed on loadedmetadata/durationchange.
   */
  pendingRestorePosition: number | null;

  /**
   * Track key of a restored entry that has not been loaded into the engine
   * yet (Phase 43). A restored session holds identity only, so the first
   * user-initiated Play must route through the controller for a fresh
   * resolution instead of resuming a source that no longer exists.
   * Cleared by any user-initiated load.
   */
  restoredTrackKey: string | null;

  /**
   * Applies an authenticated restore: loads the track without autoplay and
   * without counting as user intent. Never triggers recently-played.
   */
  restoreTrack: (track: Track, position: number) => void;
  /**
   * Applies an authenticated queue-snapshot restore: installs the exact
   * persisted queue/playOrder/cursor/shuffle/repeat as live state without
   * autoplay, recomputation, or user-intent counting. The restored queue
   * is immediately fully operable. Never triggers recently-played.
   */
  restoreQueueSnapshot: (input: {
    tracks: Track[];
    playOrder: number[];
    position: number;
    shuffle: boolean;
    repeat: RepeatMode;
    mediaPosition: number;
    currentTrack?: Track | null;
    volume?: number;
    muted?: boolean;
  }) => void;
}

let engine: PlayerEngine | null = null;

/** Pressing "previous" skips back only when the playhead is past this point. */
export const PREV_RESTART_THRESHOLD_SECONDS = 3;

/**
 * Fisher-Yates shuffle. When shuffle is enabled, the pinned track is placed at
 * position 0 so the listener doesn't lose context.
 */
function shuffledPlayOrder(
  playOrder: number[],
  pinnedPosition: number,
  rng: () => number = Math.random,
): number[] {
  const copy = [...playOrder];
  if (copy.length <= 1) return copy;

  const pinnedQueueIndex = copy[pinnedPosition];

  // Move the pinned track to position 0 by swapping
  copy[pinnedPosition] = copy[0];
  copy[0] = pinnedQueueIndex;

  // Fisher-Yates on indices 1..n-1
  for (let i = copy.length - 1; i > 1; i--) {
    const j = 1 + Math.floor(rng() * i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** True when the user asked the browser to save data: no speculative traffic. */
function isDataSaverActive(): boolean {
  try {
    const connection =
      typeof navigator !== "undefined"
        ? (navigator as Navigator & {
            connection?: { saveData?: boolean };
          }).connection
        : undefined;
    return connection?.saveData === true;
  } catch {
    return false;
  }
}

/**
 * Warms the resolution for whatever plays next, if anything does. Called when
 * the current track starts producing audio — the earliest moment the next
 * track is knowable — so a natural or manual advance finds a hot prefetch
 * slot instead of starting a cold resolution. Repeat-one replays the current
 * track (already loaded); repeat-all wraps through nextQueueIndex.
 */
function prefetchNextTrack(state: {
  queue: Track[];
  playOrder: number[];
  position: number;
  repeat: RepeatMode;
}): void {
  if (isDataSaverActive()) {
    return;
  }
  if (!playbackController) {
    return;
  }
  const nextIndex = nextQueueIndex(state);
  if (nextIndex === null) {
    return;
  }
  const next = state.queue[nextIndex];
  if (!next) {
    return;
  }
  try {
    playbackController.prefetchTrack(next);
  } catch {
    // Speculation must never break playback.
  }
}

/** Next queue-index under the current repeat mode, or null when playback ends. */
function nextQueueIndex(state: Pick<PlayerState, "playOrder" | "position" | "repeat">): number | null {
  const nextPosition = state.position + 1;
  if (nextPosition < state.playOrder.length) {
    return state.playOrder[nextPosition];
  }
  if (state.repeat === "all" && state.playOrder.length > 0) {
    return state.playOrder[0];
  }
  return null;
}

/** What to play when a track ends: honors repeat-one before everything else. */
function afterEndQueueIndex(
  state: Pick<PlayerState, "playOrder" | "position" | "repeat">,
): number | null {
  if (state.repeat === "one" && state.playOrder[state.position] !== undefined) {
    return state.playOrder[state.position];
  }
  return nextQueueIndex(state);
}

/**
 * Builds a sequential play order [0, 1, 2, ...n-1].
 */
function sequentialPlayOrder(length: number): number[] {
  return Array.from({ length }, (_, i) => i);
}

/* ==========================================================================
   CANONICAL QUEUE INVARIANT

   The active queue holds AT MOST ONE entry per canonical track. "Canonical"
   is Aurora's existing identity (`domain/track-dedupe.ts`), not a title, a
   URL or an object reference: a Spotify row and a Deezer row for one
   recording are the same entry, and so is a merged search group re-added.

   WHY HERE AND NOWHERE ELSE. Every queue mutation in the product lands on one
   of the four actions below — `replaceQueue` (play / playCollection /
   restore), `addToQueue` (QueueManager.add, radio, keep-listening),
   `playNext` (QueueManager.playNext) and `restoreQueueSnapshot`
   (authenticated persistence). Deduplicating at this layer therefore covers
   every caller with one implementation, and no component, coordinator or
   hook needs its own filter. The stable entry identity is untouched: the
   queue ARRAY SLOT is still the entry id, and a duplicate is rejected or
   merged BEFORE a slot is ever allocated, so no id churns.

   The persisted snapshot doc comment ("occurrences are preserved") predates
   this rule and is corrected in `queue-snapshot.ts`; a snapshot written
   before this change can still hold repeats, and `restoreQueueSnapshot`
   repairs one rather than trusting it.
   ========================================================================== */

/**
 * Memoized duplicate index over the live queue, keyed by the queue array's
 * identity. Every queue mutation produces a new array, so the cache is
 * invalidated exactly when the queue changes and never between two reads of
 * an unchanged queue. Building it is O(n) key insertions; a query is O(1)
 * for an exact key and O(n) matcher evaluations only on a miss.
 */
let queueDuplicateCache: {
  queueRef: readonly Track[];
  index: CanonicalDuplicateIndex;
} | null = null;

function queueDuplicateIndexOf(queue: readonly Track[]): CanonicalDuplicateIndex {
  if (queueDuplicateCache && queueDuplicateCache.queueRef === queue) {
    return queueDuplicateCache.index;
  }
  const index = new CanonicalDuplicateIndex(queue);
  queueDuplicateCache = { queueRef: queue, index };
  return index;
}

/**
 * Moves `queueIndex` to play-order position `targetPosition`, leaving the
 * queue array (and therefore every stable entry id) untouched.
 *
 * `fromPosition` is where the entry currently sits in the play order. When it
 * sits BEFORE the cursor, removing it shifts the cursor down by one, so
 * inserting at the cursor's old target would place it one slot too late; the
 * caller resolves that by passing the already-adjusted target.
 */
function moveWithinPlayOrder(
  playOrder: number[],
  queueIndex: number,
  targetPosition: number,
): number[] {
  const without = playOrder.filter((entry) => entry !== queueIndex);
  const target = Math.max(0, Math.min(targetPosition, without.length));
  return [...without.slice(0, target), queueIndex, ...without.slice(target)];
}

/**
 * Builds a fresh play order for the given queue, respecting shuffle state.
 * When shuffle is on, pins the startIndex track to position 0.
 */
function buildPlayOrder(
  queueLength: number,
  startIndex: number,
  shuffle: boolean,
): { playOrder: number[]; position: number } {
  const base = sequentialPlayOrder(queueLength);
  if (!shuffle || queueLength <= 1) {
    return { playOrder: base, position: startIndex };
  }
  const shuffled = shuffledPlayOrder(base, startIndex);
  const position = shuffled.indexOf(base[startIndex]);
  return { playOrder: shuffled, position: position === -1 ? 0 : position };
}

/**
 * Loads the track at the given queue index into the engine.
 * This navigates within the existing queue — it never replaces the queue.
 */
function loadAt(
  queueIndex: number,
  autoplay: boolean,
  set: (partial: Partial<PlayerState>) => void,
  get: () => PlayerState,
) {
  const state = get();
  const track = state.queue[queueIndex];
  if (!track) return;

  const pos = state.playOrder.indexOf(queueIndex);
  set({
    position: pos === -1 ? 0 : pos,
    currentTrack: track,
    currentTime: 0,
    duration: 0,
    error: null,
    isLoading: true,
    isPlaying: false,
    qualifiedTrackKey: null,
    pendingRestorePosition: null,
    restoredTrackKey: null,
  });

  if (playbackController) {
    playbackController.loadTrack(track, { autoplay });
  } else if (engine) {
    engine.load(track, autoplay);
  }
}

/**
 * Seeks to a pending restore position once metadata is available.
 * Clamps to the known duration; keeps the pending value when duration is
 * still unknown so a later durationchange can complete the seek.
 */
function applyPendingRestoreSeek(
  set: (partial: Partial<PlayerState>) => void,
) {
  const snapshot = usePlayerStore.getState();
  const pending = snapshot.pendingRestorePosition;
  if (pending === null || pending <= 0) {
    if (pending !== null) {
      set({ pendingRestorePosition: null });
    }
    return;
  }
  const duration = snapshot.duration;
  if (!(duration > 0)) {
    return;
  }
  const target = Math.min(pending, Math.floor(duration));
  if (engine) {
    engine.seek(target);
    const after = engine.snapshot();
    set({ currentTime: after.currentTime, pendingRestorePosition: null });
  } else {
    set({ pendingRestorePosition: null });
  }
}

export const usePlayerStore = create<PlayerState>()((set, get) => {
  const setEngineHandlers = (
    target: PlayerEngine,
  ): (() => void) => {
    const unsubscribers: Array<() => void> = [];
    const on = (
      event:
        | "timeupdate"
        | "loadedmetadata"
        | "durationchange"
        | "waiting"
        | "canplay"
        | "play"
        | "playing"
        | "pause"
        | "ended"
        | "error",
      handler: (payload: {
        currentTime?: number;
        duration?: number;
        error?: PlayerError;
      }) => void,
    ) => {
      unsubscribers.push(target.on(event, handler));
    };

    on("timeupdate", ({ currentTime }) => {
      if (typeof currentTime === "number") {
        set({ currentTime });

        const snapshot = get();
        if (
          snapshot.currentTrack &&
          snapshot.isPlaying &&
          snapshot.qualifiedTrackKey === null &&
          isQualifiedPlay(currentTime, snapshot.duration)
        ) {
          const key = trackKey(snapshot.currentTrack);
          set({ qualifiedTrackKey: key });
          if (recordPlayedAction) {
            void recordPlayedAction(snapshot.currentTrack);
          }
        }
      }
    });
    on("loadedmetadata", ({ duration }) => {
      set({ duration, isLoading: false, error: null });
      applyPendingRestoreSeek(set);
    });
    on("durationchange", ({ duration }) => {
      set({ duration });
      applyPendingRestoreSeek(set);
    });
    on("waiting", () => set({ isLoading: true }));
    on("canplay", () => set({ isLoading: false }));
    on("play", () => set({ isPlaying: true, isLoading: false, error: null }));
    on("playing", () => {
      set({ isPlaying: true, isLoading: false, error: null });
      // The current track is producing audio: the earliest knowable moment
      // for the next one. Warming its resolution now makes a natural or
      // manual advance land on a hot prefetch slot.
      prefetchNextTrack(get());
    });
    on("pause", () => set({ isPlaying: false, isLoading: false }));
    on("ended", () => {
      const state = get();
      const queueIndex = afterEndQueueIndex(state);
      if (queueIndex === null) {
        set({ isPlaying: false, isLoading: false, currentTime: 0 });
        return;
      }
      loadAt(queueIndex, true, set, get);
    });
    on("error", ({ error }) => {
      if (error) {
        // While the controller is actively recovering, it owns error
        // surfacing: intermediate failures stay internal and the final
        // outcome arrives via reportPlaybackError (success clears via the
        // playing handler instead). This includes timer-driven autoplay
        // blocks from recovery-round reloads: they carry no user gesture
        // by construction, so surfacing them would overwrite the cycle's
        // terminal source outcome with a misleading "blocked" message.
        // Outside recovery, autoplay blocks still surface immediately —
        // they need a user gesture, never a retry.
        if (playbackController?.isRecovering()) {
          set({ isPlaying: false, isLoading: false });
          return;
        }
        set({
          error: { kind: error.kind, message: error.message },
          isPlaying: false,
          isLoading: false,
        });
      }
    });

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  };

  /** Bumps the user-action generation unless a restore is being applied. */
  const countUserAction = () => {
    if (!suppressUserActionCounting) {
      set({ userActionGeneration: get().userActionGeneration + 1 });
    }
  };

  /**
   * Resumes playback through the single PlaybackController.
   *
   * A restored session (Phase 43) carries track IDENTITY only, so the
   * controller has no active source for it. ensurePlaying() would then
   * resume an element with no media, silently doing nothing. Detect that
   * case and issue a normal load instead, so the resolver produces a
   * FRESH source (persisted/expired URLs are never reused) and the
   * pending restore position is applied once metadata arrives.
   */
  const resumeThroughController = async (state: PlayerState) => {
    const track = state.currentTrack;
    if (!track) {
      return;
    }
    const needsFreshLoad =
      state.restoredTrackKey !== null &&
      state.restoredTrackKey === trackKey(track);
    if (needsFreshLoad) {
      set({ isLoading: true, error: null, restoredTrackKey: null });
      playbackController?.loadTrack(track, { autoplay: true });
      return;
    }
    await playbackController?.ensurePlaying();
  };

  return {
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    error: null,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,

    queue: [],
    playOrder: [],
    position: -1,
    shuffle: false,
    repeat: "off",

    isQueueOpen: false,

    isFullPlayerOpen: false,

    persistenceInitState: "idle",
    userActionGeneration: 0,
    pendingRestorePosition: null,
    restoredTrackKey: null,

    qualifiedTrackKey: null,

    playTrack: (track, options = {}) => {
      countUserAction();
      const autoplay = options.autoplay ?? true;
      get().replaceQueue([track], { startIndex: 0, autoplay });
    },

    replaceQueue: (tracks, options = {}) => {
      const { startIndex: rawStart = 0, autoplay = true, preserveCurrent = false } = options;
      const state = get();

      if (tracks.length === 0) {
        countUserAction();
        set({
          queue: [],
          playOrder: [],
          position: -1,
          currentTrack: null,
          currentTime: 0,
          duration: 0,
          error: null,
          isLoading: false,
          isPlaying: false,
          qualifiedTrackKey: null,
          pendingRestorePosition: null,
          restoredTrackKey: null,
        });
        engine?.pause();
        return;
      }

      // One entry per canonical track BEFORE any index is consumed. A
      // collection that arrives with repeats (a radio batch, a raw provider
      // list, a playlist re-played after a cross-provider add) collapses here
      // once, and every index below - the requested start, the preserved
      // current track, the shuffle pin - is computed against the survivors.
      const { kept, resolve } = dedupeCanonicalTracks(tracks);

      countUserAction();

      // Clamp startIndex, then re-point it at the surviving entry. A
      // requested track that was itself a duplicate resolves to the survivor
      // that absorbed it, so "play this one" always starts on that song.
      const boundedStart =
        rawStart < 0 ? 0 : rawStart >= tracks.length ? tracks.length - 1 : rawStart;
      const startIndex = resolve[boundedStart] ?? 0;

      // preserveCurrent: if the current track is in the new queue, keep it as
      // the starting point. Matched by canonical key, so a current entry
      // carried over under a different provider still counts.
      let actualStart = startIndex;
      if (preserveCurrent && state.currentTrack) {
        const currentKey = trackKey(state.currentTrack);
        const idx = kept.findIndex((t) => trackKey(t) === currentKey);
        if (idx !== -1) {
          actualStart = idx;
        }
      }

      const { playOrder, position } = buildPlayOrder(kept.length, actualStart, state.shuffle);
      const starting = kept[actualStart] as Track;

      set({
        queue: kept,
        playOrder,
        position,
        currentTrack: starting,
        currentTime: 0,
        duration: 0,
        error: null,
        isLoading: true,
        isPlaying: false,
        qualifiedTrackKey: null,
        pendingRestorePosition: null,
        restoredTrackKey: null,
      });

      if (playbackController) {
        playbackController.loadTrack(starting, { autoplay });
      } else if (engine) {
        engine.load(starting, autoplay);
      }
    },

    playCollection: (tracks, startIndex = 0) => {
      get().replaceQueue(tracks, { startIndex, autoplay: true });
    },

    playNext: (track) => {
      const state = get();
      const duplicate = queueDuplicateIndexOf(state.queue).find(track);

      if (duplicate) {
        const existingQueueIndex = duplicate.index;
        const existingPosition = state.playOrder.indexOf(existingQueueIndex);
        // The track is already queued. The single occurrence is REPOSITIONED
        // rather than duplicated: moving it to the slot after the cursor is
        // the whole point of "play next", and a second copy would defeat it.
        // An entry that is ALREADY next is left alone.
        //
        // A repeat of the track currently playing is a no-op: the cursor
        // entry cannot move without interrupting playback, and "play this
        // next" when it is already playing has no meaning.
        const isCurrent =
          state.position >= 0 && state.playOrder[state.position] === existingQueueIndex;
        if (existingPosition === -1 || isCurrent || existingPosition === state.position + 1) {
          return;
        }
        countUserAction();
        // Removing an entry that sits before the cursor pulls the cursor back
        // by one, so the insertion target moves back with it.
        const target = existingPosition < state.position ? state.position : state.position + 1;
        const playOrder = moveWithinPlayOrder(state.playOrder, existingQueueIndex, target);
        const currentQueueIndex = state.playOrder[state.position];
        const moved = currentQueueIndex === undefined ? -1 : playOrder.indexOf(currentQueueIndex);
        set({ playOrder, position: moved === -1 ? state.position : moved });
        return;
      }

      countUserAction();
      const queueIndex = state.queue.length;
      const nextQueue = [...state.queue, track];

      // Insert after current position in playOrder
      const insertPosition = state.position + 1;
      const nextOrder = [
        ...state.playOrder.slice(0, insertPosition),
        queueIndex,
        ...state.playOrder.slice(insertPosition),
      ];

      set({
        queue: nextQueue,
        playOrder: nextOrder,
      });
    },

    addToQueue: (track) => {
      const state = get();
      // A track already in the queue is a no-op. Deliberately BEFORE
      // countUserAction: nothing changes, so there is no new state to persist
      // and no user intent for an in-flight restore to protect.
      if (queueDuplicateIndexOf(state.queue).find(track)) {
        return;
      }
      countUserAction();
      const queueIndex = state.queue.length;
      set({
        queue: [...state.queue, track],
        playOrder: [...state.playOrder, queueIndex],
      });
    },

    playAtPosition: (position) => {
      countUserAction();
      const state = get();
      if (position < 0 || position >= state.playOrder.length) return;
      const queueIndex = state.playOrder[position];
      loadAt(queueIndex, true, set, get);
    },

    togglePlay: async () => {
      countUserAction();
      const state = get();
      if (!state.currentTrack) {
        return;
      }
      if (state.isPlaying) {
        if (playbackController) {
          playbackController.pause();
        } else {
          engine?.pause();
        }
        set({ isPlaying: false, isLoading: false });
        return;
      }
      if (state.error && state.error.kind === "autoplay") {
        set({ error: null });
      }
      if (playbackController) {
        await resumeThroughController(state);
        return;
      }
      try {
        await engine?.play();
      } catch (error) {
        if (error instanceof PlayerError) {
          set({
            error: { kind: error.kind, message: error.message },
            isPlaying: false,
            isLoading: false,
          });
        }
      }
    },

    play: async () => {
      countUserAction();
      if (playbackController) {
        await resumeThroughController(get());
        return;
      }
      try {
        await engine?.play();
      } catch (error) {
        if (error instanceof PlayerError) {
          set({
            error: { kind: error.kind, message: error.message },
            isPlaying: false,
            isLoading: false,
          });
        }
      }
    },

    pause: () => {
      countUserAction();
      if (playbackController) {
        playbackController.pause();
      } else {
        engine?.pause();
      }
      set({ isPlaying: false, isLoading: false });
    },

    seek: (seconds) => {
      countUserAction();
      if (!engine) {
        return;
      }
      // A restored-but-not-yet-loaded session has no media on the element, so
      // `engine.seek` writes `currentTime` onto an empty `src` and reads back
      // zero. Clearing the restore markers unconditionally therefore DESTROYED
      // the user's resume position: they scrubbed to 40s before pressing play,
      // and playback then started from 0. The intent is recorded instead, and
      // the existing restore path consumes it when the track loads.
      if (get().restoredTrackKey !== null) {
        // Clamped to non-negative only. The upper bound is deliberately NOT
        // applied here: `duration` is not yet known on a restored session, and
        // the resume path already clamps against the real duration when the
        // track loads (`clampResumePosition` in the controller).
        set({ pendingRestorePosition: Math.max(seconds, 0) });
        return;
      }
      engine.seek(seconds);
      const snapshot = engine.snapshot();
      set({
        currentTime: snapshot.currentTime,
        duration: snapshot.duration,
        pendingRestorePosition: null,
        restoredTrackKey: null,
      });
      playbackController?.notifySeekRequest(seconds);
    },

    setVolume: (value) => {
      const clamped = Number.isFinite(value)
        ? Math.min(Math.max(value, 0), 1)
        : 0;
      engine?.setVolume(clamped);
      set({ volume: clamped });
    },

    toggleMute: () => {
      engine?.toggleMute();
      set({ muted: !get().muted });
    },

    setMuted: (value) => {
      const next = value === true;
      const engineSurface = engine;
      if (engineSurface) {
        if (engineSurface.isMuted() !== next) {
          engineSurface.toggleMute();
        }
      }
      set({ muted: next });
    },

    clearError: () => set({ error: null }),

    reportPlaybackError: (kind: PlayerErrorKind, message: string) =>
      set({ error: { kind, message }, isPlaying: false, isLoading: false }),

    next: () => {
      countUserAction();
      const state = get();
      if (state.queue.length === 0 || state.playOrder.length === 0) {
        return;
      }
      const queueIndex = nextQueueIndex(state);
      if (queueIndex === null) {
        set({ isPlaying: false, isLoading: false, currentTime: 0 });
        return;
      }
      loadAt(queueIndex, true, set, get);
    },

    prev: () => {
      countUserAction();
      const state = get();
      if (!state.currentTrack || state.playOrder.length === 0) {
        return;
      }
      const restartCurrent = () => {
        engine?.seek(0);
        set({ currentTime: 0 });
      };
      if (state.currentTime > PREV_RESTART_THRESHOLD_SECONDS || state.position <= 0) {
        restartCurrent();
        return;
      }
      const queueIndex = state.playOrder[state.position - 1];
      if (queueIndex === undefined) {
        restartCurrent();
        return;
      }
      loadAt(queueIndex, true, set, get);
    },

    clearQueue: () => {
      countUserAction();
      if (playbackController) {
        playbackController.stop();
      } else {
        engine?.pause();
      }
      set({
        queue: [],
        playOrder: [],
        position: -1,
        currentTrack: null,
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        isLoading: false,
        error: null,
        pendingRestorePosition: null,
        restoredTrackKey: null,
      });
    },

    prefetchTrack: (track) => {
      // No queue mutation, no user-action counting, no error surfacing: a
      // prefetch is speculation, and speculation must be invisible.
      // Data-saver users opted out of speculative traffic; honor it here and
      // at every other prefetch entry point.
      if (isDataSaverActive()) {
        return;
      }
      try {
        playbackController?.prefetchTrack(track);
      } catch {
        // The controller's own contract is total, but the store must not
        // depend on that: a prefetch can never break playback.
      }
    },

    bindEngine: (target) => {
      engine = target;
      if (!target) {
        return () => undefined;
      }
      return setEngineHandlers(target);
    },

    openQueue: () => set({ isQueueOpen: true }),
    closeQueue: () => set({ isQueueOpen: false }),

    openFullPlayer: () => set({ isFullPlayerOpen: true }),
    closeFullPlayer: () => set({ isFullPlayerOpen: false }),

    moveQueueItem: (pos, direction) => {
      countUserAction();
      const state = get();
      const { playOrder, position } = state;
      if (playOrder.length <= 1) return;

      const targetPos = direction === "up" ? pos - 1 : pos + 1;
      if (targetPos < 0 || targetPos >= playOrder.length) return;

      const newPlayOrder = [...playOrder];
      [newPlayOrder[pos], newPlayOrder[targetPos]] = [newPlayOrder[targetPos], newPlayOrder[pos]];

      let newPosition = position;
      if (position === pos) {
        newPosition = targetPos;
      } else if (position === targetPos) {
        newPosition = pos;
      }

      set({ playOrder: newPlayOrder, position: newPosition });
    },

    removeFromQueue: (pos) => {
      countUserAction();
      const state = get();
      if (pos < 0 || pos >= state.playOrder.length) return;

      // Don't remove the currently playing track
      if (pos === state.position) return;

      const queueIndex = state.playOrder[pos];
      const newPlayOrder = state.playOrder.filter((_, i) => i !== pos);

      // Adjust position if it's after the removed item
      let newPosition = state.position;
      if (pos < state.position) {
        newPosition = state.position - 1;
      }

      // `playOrder` is a PERMUTATION of the queue slots - every index appears
      // exactly once (see the invariant tests) - so the slot just removed was
      // the only reference to `queueIndex` and that entry is now unreferenced.
      // There is no longer any case where it survives, so the branch that
      // re-checked it with an O(n) scan, and the second filter that cleaned up
      // after the case that could not happen, are both gone: two passes now
      // (drop the entry, re-point the indices above it) instead of four.
      const newQueue = state.queue.filter((_, i) => i !== queueIndex);
      const adjustedPlayOrder = newPlayOrder
        .map((qi) => (qi > queueIndex ? qi - 1 : qi))
        .filter((qi) => qi >= 0 && qi < newQueue.length);

      set({
        queue: newQueue,
        playOrder: adjustedPlayOrder,
        position: newPosition,
      });
    },

    toggleShuffle: () => {
      countUserAction();
      const state = get();
      if (state.playOrder.length === 0) return;

      if (!state.shuffle) {
        // Enable shuffle: pin current track to position 0
        const newOrder = shuffledPlayOrder(state.playOrder, state.position);
        const newPosition = newOrder.indexOf(state.playOrder[state.position]);
        set({ shuffle: true, playOrder: newOrder, position: newPosition === -1 ? 0 : newPosition });
      } else {
        // Disable shuffle: restore sequential order, find current track
        const currentQueueIndex = state.playOrder[state.position];
        const originalOrder = sequentialPlayOrder(state.queue.length);
        const newPosition = originalOrder.indexOf(currentQueueIndex);
        set({ shuffle: false, playOrder: originalOrder, position: newPosition === -1 ? 0 : newPosition });
      }
    },

    cycleRepeat: () => {
      countUserAction();
      const state = get();
      const next: RepeatMode =
        state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
      set({ repeat: next });
    },

    setPersistenceInitState: (state) => set({ persistenceInitState: state }),

    incrementUserActionGeneration: () => {
      set({ userActionGeneration: get().userActionGeneration + 1 });
    },

    restoreTrack: (track, position) => {
      const safe =
        Number.isFinite(position) && position > 0 ? Math.floor(position) : 0;
      suppressUserActionCounting = true;
      try {
        get().replaceQueue([track], { startIndex: 0, autoplay: false });
      } finally {
        suppressUserActionCounting = false;
      }
      // No restoredTrackKey here: replaceQueue already routed this
      // track through the engine, so a source is loaded and paused.
      // ensurePlaying() resumes it directly.
      if (safe > 0) {
        set({ pendingRestorePosition: safe });
      }
    },

    restoreQueueSnapshot: (input) => {
      const safeMedia =
        Number.isFinite(input.mediaPosition) && input.mediaPosition > 0
          ? Math.floor(input.mediaPosition)
          : 0;

      // A persisted snapshot written before the canonical-queue invariant can
      // hold repeats (measured on real data: 8 entries, 2 distinct). Repair
      // it HERE, at the one point a persisted queue becomes live state, and
      // rebuild coherently rather than splicing arrays: entries collapse to
      // survivors, the play order is re-pointed and de-duplicated as a
      // permutation, and the cursor is re-resolved to the surviving slot for
      // the same song. Nothing is discarded except a repeat of a track the
      // restored queue already contains, so the cursor, the shuffle order and
      // the persisted media position all still describe the same listening.
      const { kept, resolve } = dedupeCanonicalTracks(input.tracks);
      const repairedPlayOrder: number[] = [];
      const seenEntries = new Set<number>();
      for (const rawIndex of input.playOrder) {
        if (!Number.isInteger(rawIndex)) {
          continue;
        }
        const mapped = resolve[rawIndex];
        if (mapped === undefined || seenEntries.has(mapped)) {
          continue;
        }
        seenEntries.add(mapped);
        repairedPlayOrder.push(mapped);
      }
      // The cursor followed the track it pointed at. If that track was a
      // repeat, `resolve` sends the cursor to the surviving entry for the
      // same song, so the listener resumes the same music.
      const rawCursor = input.position >= 0 ? input.playOrder[input.position] : undefined;
      const cursorEntry =
        rawCursor === undefined ? undefined : resolve[rawCursor];
      const repairedPosition =
        cursorEntry === undefined
          ? -1
          : repairedPlayOrder.indexOf(cursorEntry);
      const restoredPosition = repairedPosition === -1 ? -1 : repairedPosition;
      const cursorTrack =
        input.currentTrack ??
        (restoredPosition >= 0
          ? (kept[repairedPlayOrder[restoredPosition] as number] as Track)
          : null);
      // Player preferences travel with the session: reapply them to the
      // live engine so volume/mute match before the first play.
      if (typeof input.volume === "number" && engine) {
        engine.setVolume(input.volume);
      }
      if (typeof input.muted === "boolean") {
        get().setMuted(input.muted);
      }
      // Direct set: no user-action counting, no engine calls, no
      // autoplay. Playback resolution happens on demand when the user
      // presses play (autoplay policy intact).
      set({
        queue: kept.slice(),
        playOrder: repairedPlayOrder,
        position: restoredPosition,
        shuffle: input.shuffle,
        repeat: input.repeat,
        currentTrack: cursorTrack,
        currentTime: 0,
        duration: 0,
        isPlaying: false,
        isLoading: false,
        error: null,
        qualifiedTrackKey: null,
        pendingRestorePosition: safeMedia > 0 && cursorTrack ? safeMedia : null,
        // Marks the cursor entry as identity-only: no source is loaded
        // until the user presses Play, which then resolves a fresh one.
        restoredTrackKey: cursorTrack ? trackKey(cursorTrack) : null,
        ...(typeof input.volume === "number" ? { volume: input.volume } : {}),
        ...(typeof input.muted === "boolean" ? { muted: input.muted } : {}),
      });
    },
  };
});
