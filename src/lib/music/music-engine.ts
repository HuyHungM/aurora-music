import type {
  SerializedEngineError,
  Track,
  TrackIdentity,
  TrackRef,
} from "@/lib/domain";
import {
  EngineError,
  NormalizationError,
  TrackNotFoundError,
  toTrackIdentity,
} from "@/lib/domain";
import { detectSource } from "@/lib/providers/source-detection";
import type {
  UnifiedSearchOptions,
  UnifiedSearchResult,
} from "./unified-search";
import type { QueueManager } from "./queue-manager";
import type { EngineEventPayload } from "@/lib/player/engine";
import { identityToTrack } from "./identity-track";
import { claimIntentPrefetch } from "@/lib/playback/prefetch-intent";
import type {
  MusicEngineAnyListener,
  MusicEngineEventName,
  MusicEngineListener,
  TrackEndReason,
} from "./events";
import { createMusicEventEmitter } from "./events";

/**
 * Canonical high-level MusicEngine facade over the existing subsystems.
 *
 * Orchestration only: transport delegates to the player store (which keeps
 * routing through PlaybackController), search delegates to UnifiedSearch,
 * and events derive from PlayerEngine signals plus command transitions.
 * No duplicated player, queue, persistence, registry, or resolver state.
 *
 * ```text
 *                         MusicEngine
 *                              │
 *        ┌─────────────────────┼─────────────────────┐
 *        │                     │                     │
 *        ▼                     ▼                     ▼
 * UnifiedSearch          PlayerStore          PlayerEngine
 *        │               (queue/state)         (signals)
 *        ▼                     │
 * ExtractorManager             │ (already routes via PlaybackController)
 *                              ▼
 *                        PlaybackResolver
 * ```
 */

export type EngineRepeatMode = "off" | "track" | "queue";

export type MusicPlayInput = TrackIdentity | Track | TrackRef | string;

export interface PlayInputOptions {
  autoplay?: boolean;
}

export interface MusicEngineState {
  currentTrack: TrackIdentity | null;
  queue: readonly TrackIdentity[];
  /**
   * Playback order as indices into `queue`. Published here rather than read
   * off the queue facade so a reorder repaints subscribers: `queue` is
   * deliberately reference-stable across a reorder, so selecting only `queue`
   * makes useSyncExternalStore bail out and the move/shuffle controls
   * silently stop repainting even though the model changed.
   */
  playOrder: readonly number[];
  currentIndex: number;
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: EngineRepeatMode;
  isResolving: boolean;
  error: SerializedEngineError | null;
}

/** Empty snapshot for SSR / unmounted contexts with no engine instance. */
export const EMPTY_ENGINE_STATE: MusicEngineState = {
  currentTrack: null,
  queue: [],
  playOrder: [],
  currentIndex: -1,
  isPlaying: false,
  position: 0,
  duration: 0,
  volume: 1,
  muted: false,
  shuffle: false,
  repeat: "off",
  isResolving: false,
  error: null,
};

export interface EngineStoreState {
  currentTrack: Track | null;
  queue: Track[];
  playOrder: number[];
  position: number;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: "off" | "one" | "all";
  isLoading: boolean;
  error: { kind: string; message: string } | null;
}

export interface EngineStoreActions {
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  clearError(): void;
}

export interface EngineSignalSource {
  on(
    event: "playing" | "ended" | "error",
    listener: (payload: EngineEventPayload) => void,
  ): () => void;
}

export interface SearchPort {
  search(
    query: string,
    options?: UnifiedSearchOptions,
  ): Promise<UnifiedSearchResult>;
}

export interface TrackLookup {
  provider: string;
  id: string;
}

export interface TrackLookupPort {
  getTrack(ref: TrackLookup): Promise<Track | null>;
}

export interface MusicEngineDeps {
  /** Fresh state per call: Zustand replaces the state object on every set. */
  getState: () => EngineStoreState;
  /** Stable transport action closures. */
  actions: EngineStoreActions;
  engine: EngineSignalSource;
  search: SearchPort;
  lookup: TrackLookupPort;
  /** Canonical queue boundary (Phase 14): the only queue mutation path. */
  queue: QueueManager;
  /** Store change notifications driving stateChange broadcasts. */
  subscribeStore: (listener: () => void) => () => void;
  /**
   * Background resolution for a likely-next track. Optional so tests can
   * construct facades without a controller; absent means prefetch is a no-op.
   */
  prefetchTrack?: (track: Track) => void;
}

export interface PlayCollectionOptions {
  startIndex?: number;
}

export interface MusicEngine {
  play(input: MusicPlayInput, options?: PlayInputOptions): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  togglePlay(): void;
  clearError(): void;
  stop(): void;
  skip(): void;
  previous(): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  shuffle(enabled?: boolean): void;
  setRepeat(mode: EngineRepeatMode): void;
  playCollection(tracks: Array<TrackIdentity | Track>, startIndex?: number): void;
  playAt(index: number): void;
  /**
   * Warms playback resolution for a track without playing it. Fire-and-forget:
   * hover/focus intent and next-up warming flow through here; failures vanish
   * and the slot is validated at consume time, so this can never break
   * playback or surface an error.
   */
  prefetchTrack(track: TrackIdentity | Track): void;
  readonly queue: {
    add(track: TrackIdentity | Track): void;
    playNext(track: TrackIdentity | Track): void;
    remove(index: number): void;
    move(from: number, to: number): void;
    clear(): void;
    readonly items: readonly TrackIdentity[];
    readonly currentIndex: number;
    readonly length: number;
    readonly playOrder: readonly number[];
  };
  search(query: string, options?: UnifiedSearchOptions): Promise<UnifiedSearchResult>;
  getState(): MusicEngineState;
  on<T extends MusicEngineEventName>(
    event: T,
    listener: MusicEngineListener<T>,
  ): () => void;
  off<T extends MusicEngineEventName>(
    event: T,
    listener: MusicEngineListener<T>,
  ): void;
  subscribe(listener: MusicEngineAnyListener): () => void;
  /** Failures from the controller path that never reach the engine. */
  notifyResolutionError(error: SerializedEngineError): void;
  initialize(): void;
  shutdown(): void;
  readonly initialized: boolean;
}

function isTrackIdentity(input: MusicPlayInput): input is TrackIdentity {
  return (
    typeof input === "object" &&
    input !== null &&
    Array.isArray((input as Partial<TrackIdentity>).sources) &&
    typeof (input as Partial<TrackIdentity>).primarySource === "object"
  );
}

function isTrack(input: MusicPlayInput): input is Track {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as Partial<Track>).provider === "string" &&
    typeof (input as Partial<Track>).artistName === "string" &&
    !Array.isArray((input as Partial<TrackIdentity>).sources)
  );
}

function isTrackRef(input: MusicPlayInput): input is TrackRef {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as Partial<TrackRef>).provider === "string" &&
    typeof (input as Partial<TrackRef>).providerTrackId === "string" &&
    !Array.isArray((input as Partial<TrackIdentity>).sources) &&
    typeof (input as Partial<Track>).artistName !== "string"
  );
}

export function createMusicEngine(deps: MusicEngineDeps): MusicEngine {
  const { getState, actions, engine, search, lookup, queue: queueManager } = deps;
  const emitter = createMusicEventEmitter();
  let initialized = false;
  let disposed = false;
  let unsubscribers: Array<() => void> = [];
  let lastStartedKey: string | null = null;
  let lastStartedTrack: TrackIdentity | null = null;
  let lastStartedIndex = -1;

  // Snapshot stability: Track objects are immutable, so converted
  // identities are cached per Track reference and queue arrays are reused
  // when every element matches by ref. This keeps selector comparisons
  // stable across unrelated updates such as progress ticks. Snapshots are
  // rebuilt on every call (cheap field copies + cache lookups) and frozen,
  // so consumers can neither observe stale data nor corrupt shared state.
  let lastQueueRef: Track[] | null = null;
  let lastItems: readonly TrackIdentity[] = [];
  const identityCache = new Map<Track, TrackIdentity>();
  // playOrder needs the same treatment as queue: the queue manager hands back
  // a defensive copy (`[...state.playOrder]`) on every getSnapshot(), so
  // selecting it directly would yield a fresh reference on every
  // notification and re-render subscribers in a loop.
  let lastPlayOrder: readonly number[] = [];
  // Serialized errors must be reference-stable across snapshots while the
  // underlying store error is unchanged. A fresh literal per getState()
  // breaks useSyncExternalStore consumers (infinite render-phase retries
  // the moment any playback error is set).
  let lastStoreError: EngineStoreState["error"] | undefined = undefined;
  let lastSerializedError: MusicEngineState["error"] = null;

  function assertUsable(): void {
    if (disposed) {
      throw new EngineError("ENGINE_ERROR", "MusicEngine is shut down");
    }
  }

  function safeIdentity(track: Track | null): TrackIdentity | null {
    if (!track) {
      return null;
    }
    try {
      return toTrackIdentity(track);
    } catch {
      return null;
    }
  }

  function cachedIdentity(track: Track | null): TrackIdentity | null {
    if (!track) {
      return null;
    }
    const hit = identityCache.get(track);
    if (hit) {
      return hit;
    }
    const identity = safeIdentity(track);
    if (identity) {
      Object.freeze(identity);
      identityCache.set(track, identity);
    }
    return identity;
  }

  function pruneIdentityCache(queue: Track[]): void {
    if (queue === lastQueueRef) {
      return;
    }
    lastQueueRef = queue;
    if (identityCache.size === 0) {
      return;
    }
    const live = new Set(queue);
    for (const track of identityCache.keys()) {
      if (!live.has(track)) {
        identityCache.delete(track);
      }
    }
  }

  function sourceKey(identity: TrackIdentity): string {
    return `${identity.primarySource.source}:${identity.primarySource.id}`;
  }

  function snapshotQueue(): readonly TrackIdentity[] {
    const state = getState();
    pruneIdentityCache(state.queue);
    const out: TrackIdentity[] = [];
    for (const track of state.queue) {
      const identity = cachedIdentity(track);
      if (identity) {
        out.push(identity);
      }
    }
    // Reuse the previous array when every element matches by reference so
    // selectors stay stable across unrelated updates such as progress ticks.
    if (
      out.length === lastItems.length &&
      out.every((item, index) => item === lastItems[index])
    ) {
      return lastItems;
    }
    lastItems = Object.freeze(out);
    return lastItems;
  }

  function snapshotPlayOrder(): readonly number[] {
    const playOrder = queueManager.getOrderState().playOrder;
    // Same reference-stabilization as snapshotQueue: the manager hands back
    // a defensive copy, so without this every snapshot would look like a
    // reorder and useSyncExternalStore would re-render forever.
    if (
      playOrder.length === lastPlayOrder.length &&
      playOrder.every((item, index) => item === lastPlayOrder[index])
    ) {
      return lastPlayOrder;
    }
    lastPlayOrder = Object.freeze(playOrder.slice());
    return lastPlayOrder;
  }

  function currentIdentity(): TrackIdentity | null {
    // Cached conversion (not the manager's fresh objects): toTrackIdentity
    // mints a new internal id per call, so only the cache keeps snapshot
    // references stable across unrelated store updates.
    return cachedIdentity(getState().currentTrack);
  }

  function snapshotError(): MusicEngineState["error"] {
    const storeError = getState().error;
    if (lastStoreError === undefined || storeError !== lastStoreError) {
      lastStoreError = storeError;
      if (!storeError) {
        lastSerializedError = null;
      } else {
        const serialized: SerializedEngineError = {
          name: "PlayerError",
          code: "ENGINE_ERROR",
          message: storeError.message,
          retryable: false,
        };
        lastSerializedError = Object.freeze(serialized) as SerializedEngineError;
      }
    }
    return lastSerializedError;
  }

  function buildSnapshot(): MusicEngineState {
    const state = getState();
    // Order fields only. `getSnapshot()` would also map every queue entry to
    // a canonical identity (one id minted per entry) and that array is
    // discarded here — the queue itself is published by `snapshotQueue()`
    // from the reference cache below. This runs once per store notification
    // per subscriber, so at 4Hz engine ticks the discarded map was the
    // single largest allocation on the playback path.
    const order = queueManager.getOrderState();
    // Frozen at runtime (verified by tests); the cast reflects that the
    // shape is unchanged, only sealed against consumer mutation.
    const snapshot = {
      currentTrack: currentIdentity(),
      queue: snapshotQueue(),
      playOrder: snapshotPlayOrder(),
      currentIndex: order.currentIndex,
      isPlaying: state.isPlaying,
      // Whole seconds, not the raw float. Progress UI renders seconds (time
      // labels, 1s slider steps), so sub-second ticks would re-render every
      // subscriber for a value nobody displays: flooring collapses the 4Hz
      // engine ticks into 1Hz snapshot changes and the per-hook `Object.is`
      // bail-out does the rest. The store keeps the raw float - seek math,
      // persistence deltas and Media Session read it there, never here.
      position: Math.floor(Math.max(0, state.currentTime)),
      duration: state.duration,
      volume: state.volume,
      muted: state.muted,
      shuffle: order.shuffle,
      repeat: order.repeat,
      isResolving: state.isLoading,
      error: snapshotError(),
    } as MusicEngineState;
    return Object.freeze(snapshot);
  }

  async function resolveToTrack(input: MusicPlayInput): Promise<Track> {
    if (isTrackIdentity(input)) {
      return identityToTrack(input);
    }
    if (isTrack(input)) {
      return input;
    }
    if (isTrackRef(input)) {
      const track = await lookup.getTrack({
        provider: input.provider,
        id: input.providerTrackId,
      });
      if (!track) {
        throw new TrackNotFoundError({
          provider: input.provider,
          providerTrackId: input.providerTrackId,
        });
      }
      return track;
    }
    if (typeof input === "string") {
      const trimmed = input.trim();
      if (trimmed.length === 0) {
        throw new NormalizationError("query", "Cannot play an empty input");
      }
      // Supported provider URL: resolve the exact resource, never search.
      const detected = detectSource(trimmed);
      if (detected) {
        const track = await lookup.getTrack({
          provider: detected.provider,
          id: detected.id,
        });
        if (!track) {
          throw new TrackNotFoundError({
            provider: detected.provider,
            providerTrackId: detected.id,
          });
        }
        return track;
      }
      // Plain text: deterministic first suitable UnifiedSearch result.
      const result = await search.search(trimmed);
      const first = result.tracks[0];
      if (!first) {
        throw new NormalizationError("query", `No results for "${trimmed}"`);
      }
      return identityToTrack(first);
    }
    throw new NormalizationError("input", "Unsupported play input");
  }

  function emitTrackEndFromCommand(reason: TrackEndReason): void {
    const track = currentIdentity();
    if (!track) {
      return;
    }
    const index = queueManager.getCurrentIndex();
    lastStartedKey = null;
    lastStartedTrack = null;
    lastStartedIndex = -1;
    emitter.emit("trackEnd", { track, index, reason });
  }

  function onPlaying(): void {
    if (disposed) {
      return;
    }
    const track = currentIdentity();
    if (!track) {
      return;
    }
    const key = sourceKey(track);
    if (key === lastStartedKey) {
      return;
    }
    lastStartedKey = key;
    lastStartedTrack = track;
    lastStartedIndex = queueManager.getCurrentIndex();
    emitter.emit("trackStart", { track, index: queueManager.getCurrentIndex() });
  }

  function onEnded(): void {
    if (disposed) {
      return;
    }
    const previous = lastStartedTrack;
    const previousIndex = lastStartedIndex;
    lastStartedKey = null;
    lastStartedTrack = null;
    lastStartedIndex = -1;
    if (previous) {
      emitter.emit("trackEnd", {
        track: previous,
        index: previousIndex,
        reason: "natural",
      });
    }
    // The store's own ended handler runs first (subscribed earlier), so a
    // changed current track means a transition is already in flight and its
    // trackStart arrives with the next playing signal.
    const current = currentIdentity();
    const transitioned =
      current !== null &&
      previous !== null &&
      sourceKey(current) !== sourceKey(previous);
    if (!transitioned && !getState().isLoading) {
      emitter.emit("queueEnd", { queue: snapshotQueue() });
    }
  }

  // trackError fires only for errors that survive to the user-facing
  // state. Transient engine failures cleared by a recovery cycle in the
  // same task never emit: the deferred re-check below observes the final
  // outcome instead of every intermediate signal.
  let lastReportedError: EngineStoreState["error"] = null;

  function reportStoreErrorTransition(): void {
    const current = getState().error;
    if (!current || current === lastReportedError) {
      return;
    }
    lastReportedError = current;
    const captured = current;
    void Promise.resolve().then(() => {
      if (disposed) {
        return;
      }
      if (getState().error !== captured) {
        return;
      }
      const serialized = snapshotError();
      if (!serialized) {
        return;
      }
      const track = currentIdentity() ?? lastStartedTrack ?? undefined;
      emitter.emit("trackError", {
        ...(track ? { track } : {}),
        error: serialized,
      });
    });
  }

  const queueFacade: MusicEngine["queue"] = {
    add(track: TrackIdentity | Track): void {
      assertUsable();
      queueManager.add(track);
    },
    playNext(track: TrackIdentity | Track): void {
      assertUsable();
      queueManager.playNext(track);
    },
    remove(index: number): void {
      assertUsable();
      queueManager.remove(index);
    },
    move(from: number, to: number): void {
      assertUsable();
      queueManager.move(from, to);
    },
    clear(): void {
      assertUsable();
      queueManager.clear();
    },
    get items(): readonly TrackIdentity[] {
      return snapshotQueue();
    },
    get currentIndex(): number {
      return queueManager.getCurrentIndex();
    },
    get length(): number {
      // Not `getSnapshot().items.length`: reading a length must not
      // canonicalize the whole queue, and radio/keep-listening poll this on
      // every queue change.
      return queueManager.getOrderState().playOrder.length;
    },
    get playOrder(): readonly number[] {
      return snapshotPlayOrder();
    },
  };

  return {
    async play(input: MusicPlayInput, options: PlayInputOptions = {}): Promise<void> {
      assertUsable();
      const track = await resolveToTrack(input);
      queueManager.play(track, { autoplay: options.autoplay ?? true });
    },

    pause(): void {
      assertUsable();
      actions.pause();
    },

    async resume(): Promise<void> {
      assertUsable();
      await actions.play();
    },

    togglePlay(): void {
      assertUsable();
      const state = getState();
      if (!state.currentTrack) {
        return;
      }
      if (state.isPlaying) {
        actions.pause();
        return;
      }
      if (state.error && state.error.kind === "autoplay") {
        actions.clearError();
      }
      void actions.play();
    },

    clearError(): void {
      assertUsable();
      actions.clearError();
    },

    toggleMute(): void {
      assertUsable();
      actions.toggleMute();
    },

    playCollection(
      tracks: Array<TrackIdentity | Track>,
      startIndex = 0,
    ): void {
      assertUsable();
      queueManager.replace(tracks, { startIndex, autoplay: true });
    },

    playAt(index: number): void {
      assertUsable();
      queueManager.playAt(index);
    },

    prefetchTrack(input: TrackIdentity | Track): void {
      // No assertUsable: a hover that races unmount must vanish, not throw.
      // Admission lives here, not in the component, so every UI entry point
      // shares one policy without importing playback internals (the UI engine
      // boundary forbids components from reaching past this facade):
      //
      // - youtube only. Server resolution is the expensive path being warmed;
      //   local files need no warming, and offline rows must not mint object
      //   URLs speculatively.
      // - one intent gate for sweeps and re-hovers (throttle + remembered
      //   keys). Programmatic next-up warming bypasses this on purpose — it
      //   goes store → controller directly, because a throttle tuned for
      //   pointer sweeps must never starve the actual next track.
      try {
        const track =
          isTrackIdentity(input) ? identityToTrack(input) : input;
        if (track.provider !== "youtube") {
          return;
        }
        const key = `${track.provider}:${track.providerTrackId ?? track.id}`;
        if (!claimIntentPrefetch(key)) {
          return;
        }
        deps.prefetchTrack?.(track);
      } catch {
        // Speculation must never break playback.
      }
    },

    stop(): void {
      assertUsable();
      emitTrackEndFromCommand("stop");
      queueManager.clear();
    },

    skip(): void {
      assertUsable();
      emitTrackEndFromCommand("skip");
      queueManager.next();
    },

    previous(): void {
      assertUsable();
      emitTrackEndFromCommand("skip");
      queueManager.previous();
    },

    seek(seconds: number): void {
      assertUsable();
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new NormalizationError("seconds", `Invalid seek position: ${seconds}`);
      }
      actions.seek(seconds);
    },

    setVolume(volume: number): void {
      assertUsable();
      if (!Number.isFinite(volume)) {
        throw new NormalizationError("volume", `Invalid volume: ${volume}`);
      }
      actions.setVolume(volume);
    },

    shuffle(enabled?: boolean): void {
      assertUsable();
      if (enabled === undefined) {
        queueManager.setShuffle(!queueManager.getSnapshot().shuffle);
        return;
      }
      queueManager.setShuffle(enabled);
    },

    setRepeat(mode: EngineRepeatMode): void {
      assertUsable();
      queueManager.setRepeat(mode);
    },

    queue: queueFacade,

    async search(
      query: string,
      options?: UnifiedSearchOptions,
    ): Promise<UnifiedSearchResult> {
      assertUsable();
      const trimmed = query.trim();
      if (trimmed.length === 0) {
        throw new NormalizationError("query", "Search requires a non-empty query");
      }
      return search.search(trimmed, options);
    },

    getState(): MusicEngineState {
      return buildSnapshot();
    },

    on(event, listener) {
      return emitter.on(event, listener);
    },

    off(event, listener) {
      emitter.off(event, listener);
    },

    subscribe(listener) {
      return emitter.subscribe(listener);
    },

    notifyResolutionError(error: SerializedEngineError): void {
      if (disposed) {
        return;
      }
      const track = currentIdentity() ?? lastStartedTrack ?? undefined;
      emitter.emit("trackError", {
        ...(track ? { track } : {}),
        error,
      });
    },

    initialize(): void {
      if (initialized) {
        return;
      }
      initialized = true;
      disposed = false;
      lastReportedError = getState().error;
      unsubscribers = [
        engine.on("playing", onPlaying),
        engine.on("ended", onEnded),
        deps.subscribeStore(() => {
          if (disposed) {
            return;
          }
          emitter.emit("stateChange", { state: buildSnapshot() });
          reportStoreErrorTransition();
        }),
      ];
    },

    shutdown(): void {
      disposed = true;
      initialized = false;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      unsubscribers = [];
      lastStartedKey = null;
      lastStartedTrack = null;
      lastStartedIndex = -1;
      lastQueueRef = null;
      lastItems = [];
      lastPlayOrder = [];
      identityCache.clear();
      lastStoreError = undefined;
      lastSerializedError = null;
      lastReportedError = null;
    },

    get initialized(): boolean {
      return initialized;
    },
  };
}

export type {
  MusicEngineEvents,
  MusicEngineEventName,
  MusicEngineListener,
  MusicEngineAnyListener,
  TrackEndReason,
} from "./events";
export type { UnifiedSearchOptions, UnifiedSearchResult } from "./unified-search";
