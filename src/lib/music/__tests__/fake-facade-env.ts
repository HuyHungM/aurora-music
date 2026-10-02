import type { Track, TrackIdentity } from "@/lib/domain";
import type { EngineEventPayload } from "@/lib/player/engine";
import type { EngineStoreActions, EngineStoreState } from "@/lib/music/music-engine";
import type { EngineSignalSource } from "@/lib/music/music-engine";
import type { UnifiedSearchResult } from "@/lib/music/unified-search";

/**
 * Test-only MusicEngine environment: fake store, fake engine signals,
 * fake search and lookup ports. No network, no DOM, no Zustand.
 */

export function track(
  provider = "youtube",
  id = "yt-1",
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    provider,
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: `${provider}-a1`,
    artistName: "Artist",
    ...overrides,
  };
}

export function identity(
  source: "youtube" | "spotify" | "deezer" = "youtube",
  id = "yt-1",
  overrides: Partial<TrackIdentity> = {},
): TrackIdentity {
  return {
    id: `aurora-${source}-${id}`,
    title: `Song ${id}`,
    artists: [{ id: "a1", provider: source, name: "Artist" }],
    sources: [{ source, id }],
    primarySource: { source, id },
    ...overrides,
  };
}

import type { QueueStoreActions } from "@/lib/music/queue-manager";

export interface FakeActions extends EngineStoreActions, QueueStoreActions {
  calls: Array<{ action: string; args: unknown[] }>;
}

export interface FakeEnv {
  state: EngineStoreState;
  actions: FakeActions;
}

export function fakeEnv(initial: Partial<EngineStoreState> = {}): FakeEnv {
  const calls: FakeActions["calls"] = [];
  const record = (action: string, args: unknown[] = []) => {
    calls.push({ action, args });
  };
  const state: EngineStoreState = {
    currentTrack: null,
    queue: [],
    playOrder: [],
    position: -1,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    shuffle: false,
    repeat: "off",
    isLoading: false,
    error: null,
    ...initial,
  };
  const actions: FakeActions = {
    calls,
    playTrack(track: Track, options?: { autoplay?: boolean }): void {
      record("playTrack", [track, options]);
      actions.replaceQueue([track], { startIndex: 0, autoplay: options?.autoplay });
    },
    replaceQueue(
      tracks: Track[],
      options: { startIndex?: number; autoplay?: boolean } = {},
    ): void {
      record("replaceQueue", [tracks, options]);
      const startIndex = options.startIndex ?? 0;
      state.queue = [...tracks];
      state.playOrder = tracks.map((_, index) => index);
      state.position = tracks.length === 0 ? -1 : Math.min(startIndex, tracks.length - 1);
      state.currentTrack = tracks.length === 0 ? null : (tracks[state.position] ?? null);
    },
    playCollection(tracks: Track[], startIndex = 0): void {
      record("playCollection", [tracks, startIndex]);
      actions.replaceQueue(tracks, { startIndex, autoplay: true });
    },
    playNext(track: Track): void {
      record("playNext", [track]);
      state.queue = [...state.queue, track];
    },
    addToQueue(track: Track): void {
      record("addToQueue", [track]);
      state.queue = [...state.queue, track];
      state.playOrder = [...state.playOrder, state.queue.length - 1];
    },
    playAtPosition(position: number): void {
      record("playAtPosition", [position]);
      state.position = position;
      state.currentTrack = state.queue[state.playOrder[position] as number] ?? null;
    },
    next(): void {
      record("next");
      if (state.position + 1 < state.playOrder.length) {
        actions.playAtPosition(state.position + 1);
      }
    },
    prev(): void {
      record("prev");
      if (state.position > 0) {
        actions.playAtPosition(state.position - 1);
      }
    },
    async play(): Promise<void> {
      record("play");
    },
    toggleMute(): void {
      record("toggleMute");
      state.muted = !state.muted;
    },
    clearError(): void {
      record("clearError");
      state.error = null;
    },
    pause(): void {
      record("pause");
      state.isPlaying = false;
    },
    seek(seconds: number): void {
      record("seek", [seconds]);
      state.currentTime = seconds;
    },
    setVolume(volume: number): void {
      record("setVolume", [volume]);
      state.volume = volume;
    },
    clearQueue(): void {
      record("clearQueue");
      state.queue = [];
      state.playOrder = [];
      state.position = -1;
      state.currentTrack = null;
    },
    toggleShuffle(): void {
      record("toggleShuffle");
      state.shuffle = !state.shuffle;
    },
    cycleRepeat(): void {
      record("cycleRepeat");
      state.repeat = state.repeat === "off" ? "all" : state.repeat === "all" ? "one" : "off";
    },
    moveQueueItem(position: number, direction: "up" | "down"): void {
      record("moveQueueItem", [position, direction]);
      const target = direction === "up" ? position - 1 : position + 1;
      if (target < 0 || target >= state.playOrder.length) {
        return;
      }
      const order = [...state.playOrder];
      const current = order[position] as number;
      order[position] = order[target] as number;
      order[target] = current;
      state.playOrder = order;
      if (state.position === position) {
        state.position = target;
      } else if (state.position === target) {
        state.position = position;
      }
    },
    removeFromQueue(position: number): void {
      record("removeFromQueue", [position]);
      if (position === state.position) {
        return;
      }
      const queueIndex = state.playOrder[position];
      const order = state.playOrder.filter((_, index) => index !== position);
      let nextPosition = state.position;
      if (position < state.position) {
        nextPosition = state.position - 1;
      }
      if (!order.some((entry) => entry === queueIndex)) {
        state.queue = state.queue.filter((_, index) => index !== queueIndex);
        state.playOrder = order
          .map((entry) => ((entry as number) > (queueIndex as number) ? (entry as number) - 1 : entry))
          .filter((entry) => (entry as number) >= 0 && (entry as number) < state.queue.length);
      } else {
        state.playOrder = order;
      }
      state.position = nextPosition;
    },
  };
  return { state, actions };
}

export interface FakeSignals extends EngineSignalSource {
  emitPlaying(): void;
  emitEnded(): void;
  emitError(): void;
  listenerCount(): number;
}

export function fakeSignals(): FakeSignals {
  const listeners: Record<string, Array<(payload: EngineEventPayload) => void>> = {
    playing: [],
    ended: [],
    error: [],
  };
  return {
    on: (event, listener) => {
      listeners[event].push(listener);
      return () => {
        const index = listeners[event].indexOf(listener);
        if (index !== -1) {
          listeners[event].splice(index, 1);
        }
      };
    },
    emitPlaying: () => {
      for (const listener of [...listeners.playing]) {
        listener({});
      }
    },
    emitEnded: () => {
      for (const listener of [...listeners.ended]) {
        listener({});
      }
    },
    emitError: () => {
      for (const listener of [...listeners.error]) {
        listener({ error: { kind: "playback", message: "boom", name: "PlayerError" } as never });
      }
    },
    listenerCount: () =>
      listeners.playing.length + listeners.ended.length + listeners.error.length,
  };
}

export function searchResult(tracks: TrackIdentity[] = []): UnifiedSearchResult {
  return {
    query: "x",
    tracks,
    providers: [],
    succeeded: true,
    partial: false,
    diagnostics: {
      groups: tracks.length,
      mergedSources: 0,
      ties: 0,
      skippedMalformed: 0,
      matchCounts: { exact: 0, strong: 0, possible: 0, rejected: 0 },
      rankingMs: 0,
      topBand: null,
    },
  };
}

