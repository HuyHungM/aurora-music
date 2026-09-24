import { create } from "zustand";
import type { Track } from "@/lib/domain";
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
  playAtPosition: (position: number) => void;
  togglePlay: () => Promise<void>;
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
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
   * Applies an authenticated restore: loads the track without autoplay and
   * without counting as user intent. Never triggers recently-played.
   */
  restoreTrack: (track: Track, position: number) => void;
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
    on("playing", () => set({ isPlaying: true, isLoading: false, error: null }));
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

    qualifiedTrackKey: null,

    playTrack: (track, options = {}) => {
      countUserAction();
      const autoplay = options.autoplay ?? true;
      get().replaceQueue([track], { startIndex: 0, autoplay });
    },

    replaceQueue: (tracks, options = {}) => {
      const { startIndex: rawStart = 0, autoplay = true, preserveCurrent = false } = options;
      countUserAction();
      const state = get();

      if (tracks.length === 0) {
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
        });
        engine?.pause();
        return;
      }

      // Clamp startIndex
      const startIndex = rawStart < 0 ? 0 : rawStart >= tracks.length ? tracks.length - 1 : rawStart;

      // preserveCurrent: if the current track is in the new queue, keep it as the starting point
      let actualStart = startIndex;
      if (preserveCurrent && state.currentTrack) {
        const currentKey = trackKey(state.currentTrack);
        const idx = tracks.findIndex((t) => trackKey(t) === currentKey);
        if (idx !== -1) {
          actualStart = idx;
        }
      }

      const { playOrder, position } = buildPlayOrder(tracks.length, actualStart, state.shuffle);

      set({
        queue: tracks,
        playOrder,
        position,
        currentTrack: tracks[actualStart],
        currentTime: 0,
        duration: 0,
        error: null,
        isLoading: true,
        isPlaying: false,
        qualifiedTrackKey: null,
        pendingRestorePosition: null,
      });

      if (playbackController) {
        playbackController.loadTrack(tracks[actualStart], { autoplay });
      } else if (engine) {
        engine.load(tracks[actualStart], autoplay);
      }
    },

    playCollection: (tracks, startIndex = 0) => {
      countUserAction();
      get().replaceQueue(tracks, { startIndex, autoplay: true });
    },

    playNext: (track) => {
      countUserAction();
      const state = get();
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
      countUserAction();
      const state = get();
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
        await playbackController.ensurePlaying();
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
        await playbackController.ensurePlaying();
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
      engine.seek(seconds);
      const snapshot = engine.snapshot();
      set({
        currentTime: snapshot.currentTime,
        duration: snapshot.duration,
        pendingRestorePosition: null,
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
      });
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

      // Check if this queue index is still referenced
      const isStillReferenced = newPlayOrder.some((qi) => qi === queueIndex);
      let newQueue = state.queue;
      let adjustedPlayOrder = newPlayOrder;

      if (!isStillReferenced) {
        // Remove the track from queue and rebuild playOrder references
        newQueue = state.queue.filter((_, i) => i !== queueIndex);
        adjustedPlayOrder = newPlayOrder
          .map((qi) => (qi > queueIndex ? qi - 1 : qi))
          .filter((qi) => qi >= 0 && qi < newQueue.length);
      }

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
      if (safe > 0) {
        set({ pendingRestorePosition: safe });
      }
    },
  };
});
