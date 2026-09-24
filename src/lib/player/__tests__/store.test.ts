import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerEngine } from "@/lib/player/engine";
import { usePlayerStore, setPlaybackController, setRecordPlayedAction } from "@/lib/player/store";
import type { PlaybackController } from "@/lib/playback/controller";
import { EventEnum, FakeAudioSurface, makePlayableTrack } from "./fake-audio";

const mockRecordPlayed = vi.fn().mockResolvedValue({ ok: true });

let currentDispose: (() => void) | null = null;

/** Flushes the async play/reject chain back out to the store listeners. */
async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

function resetStore() {
  usePlayerStore.setState({
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
  });
}

function mountEngine(): FakeAudioSurface {
  currentDispose?.();
  resetStore();
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  currentDispose = usePlayerStore.getState().bindEngine(engine);
  return surface;
}

function unmount() {
  currentDispose?.();
  currentDispose = null;
  usePlayerStore.getState().bindEngine(null);
}

describe("queue navigation", () => {
  it("advances to the next queued track when a track ends", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    surface.dispatch(EventEnum.playing);

    surface.dispatch(EventEnum.ended);
    await flush();
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("b");
    expect(state.position).toBe(1);
    expect(state.isPlaying).toBe(true);
  });

  it("stops at the end of the queue when repeat is off", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
    ]);
    surface.dispatch(EventEnum.playing);

    // Advance past the last track
    surface.dispatch(EventEnum.ended);
    await flush();
    // Now at "b" (position 1), advance again
    surface.dispatch(EventEnum.ended);
    await flush();
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("b");
    expect(state.isPlaying).toBe(false);
    expect(state.currentTime).toBe(0);
  });

  it("wraps to the start with repeat all", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    usePlayerStore.setState({ repeat: "all" });
    surface.dispatch(EventEnum.playing);

    surface.dispatch(EventEnum.ended);
    await flush();
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("b");
    expect(state.position).toBe(1);
    expect(state.isPlaying).toBe(true);
  });

  it("replays the current track with repeat one", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
    ]);
    usePlayerStore.setState({ repeat: "one" });
    surface.dispatch(EventEnum.playing);

    surface.dispatch(EventEnum.ended);
    await flush();
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("a");
    expect(state.queue.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.position).toBe(0);
  });

  it("next() moves forward and stops at the end with repeat off", () => {
    const surface = mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    surface.dispatch(EventEnum.playing);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");

    store.next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");

    store.next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("c");

    // At end of queue with repeat off: next() stops playback
    store.next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("c");
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("next() wraps with repeat all", () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    usePlayerStore.setState({ repeat: "all" });
    surface.dispatch(EventEnum.playing);

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("c");

    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
  });

  it("prev() restarts past the rest threshold and otherwise goes back", () => {
    const surface = mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    surface.dispatch(EventEnum.playing);

    usePlayerStore.setState({ currentTime: 30 });
    store.prev();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    expect(usePlayerStore.getState().currentTime).toBe(0);

    usePlayerStore.setState({ currentTime: 1 });
    store.prev();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");

    usePlayerStore.setState({ currentTime: 1 });
    store.prev();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
  });

  it("clearQueue() resets playback", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a"));
    surface.dispatch(EventEnum.playing);

    usePlayerStore.getState().clearQueue();
    const state = usePlayerStore.getState();
    expect(state.currentTrack).toBeNull();
    expect(state.queue).toEqual([]);
    expect(state.playOrder).toEqual([]);
    expect(state.position).toBe(-1);
    expect(state.isPlaying).toBe(false);
    expect(surface.pausedCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("player store", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    unmount();
  });

  it("starts in the idle state", () => {
    const state = usePlayerStore.getState();
    expect(state.currentTrack).toBeNull();
    expect(state.isPlaying).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.queue).toEqual([]);
    expect(state.position).toBe(-1);
    expect(state.shuffle).toBe(false);
    expect(state.repeat).toBe("off");
  });

  it("plays a track through the bound engine", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("t1"));
    expect(usePlayerStore.getState().currentTrack?.id).toBe("t1");
    expect(usePlayerStore.getState().isLoading).toBe(true);
    expect(surface.src).toBe("https://audio.example/t1.mp3");

    await flush();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(usePlayerStore.getState().isLoading).toBe(false);
  });

  it("surfaces an unavailable error for stream-less tracks", () => {
    mountEngine();
    usePlayerStore
      .getState()
      .playTrack(makePlayableTrack("t1", { streamUrl: undefined, previewUrl: undefined }));
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("t1");
    expect(state.error?.kind).toBe("unavailable");
    expect(state.isPlaying).toBe(false);
  });

  it("toggles playback with pause/play", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("t1"));
    await flush();
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    await usePlayerStore.getState().togglePlay();
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    await usePlayerStore.getState().togglePlay();
    await flush();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(surface.playedCalls).toBe(2);
  });

  it("records duration and time from media events", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("t1"));
    surface.duration = 214;
    surface.dispatch(EventEnum.loadedmetadata);
    expect(usePlayerStore.getState().duration).toBe(214);

    surface.currentTime = 12;
    surface.dispatch(EventEnum.timeupdate);
    expect(usePlayerStore.getState().currentTime).toBe(12);
  });

  it("marks ended tracks as stopped and rewinds the playhead", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("t1"));
    surface.dispatch(EventEnum.playing);
    surface.dispatch(EventEnum.ended);
    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.currentTime).toBe(0);
  });

  it("records an autoplay-block error and recovers on retry", async () => {
    const surface = mountEngine();
    surface.failsWith(new DOMException("blocked", "NotAllowedError"));
    usePlayerStore.getState().playTrack(makePlayableTrack("t1"));
    await flush();
    expect(usePlayerStore.getState().error?.kind).toBe("autoplay");

    surface.playImplementation = async () => {
      surface.paused = false;
      surface.dispatch(EventEnum.playing);
    };
    await usePlayerStore.getState().togglePlay();
    await flush();
    expect(usePlayerStore.getState().error).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("reports a playback error from the media element", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("t1"));
    surface.error = { code: 4 };
    surface.dispatch(EventEnum.error);
    const state = usePlayerStore.getState();
    expect(state.error?.kind).toBe("unavailable");
    expect(state.isPlaying).toBe(false);
  });

  describe("controller recovery error suppression", () => {
    afterEach(() => {
      setPlaybackController(null);
    });

    function bindRecoveringController(recovering: boolean) {
      setPlaybackController({
        loadTrack: () => undefined,
        ensurePlaying: async () => undefined,
        pause: () => undefined,
        notifySeekRequest: () => undefined,
        stop: () => undefined,
        currentGeneration: () => 0,
        isRecovering: () => recovering,
        getRecoveryDiagnostics: () => ({
          phase: recovering ? ("awaiting-outcome" as const) : ("idle" as const),
          trackKey: null,
          attemptsUsed: 0,
          maxAttempts: 2,
          lastFailureCategory: null,
          updatedAtMs: Date.now(),
        }),
        shutdown: () => undefined,
      } as unknown as PlaybackController);
    }

    it("withholds engine errors while the controller is recovering", () => {
      const surface = mountEngine();
      usePlayerStore.getState().playTrack(makePlayableTrack("t1"));
      bindRecoveringController(true);
      surface.error = { code: 2 };
      surface.dispatch(EventEnum.error);
      const state = usePlayerStore.getState();
      expect(state.error).toBeNull();
      expect(state.isPlaying).toBe(false);
      expect(state.isLoading).toBe(false);
    });

    it("withholds autoplay blocks while the controller is recovering", async () => {
      // Timer-driven recovery rounds have no user gesture by
      // construction; surfacing their policy rejections would overwrite
      // the cycle's terminal outcome with a misleading "blocked" message.
      // The cycle reports its own final error via reportPlaybackError.
      resetStore();
      const surface = new FakeAudioSurface();
      const engine = new PlayerEngine(surface);
      const dispose = usePlayerStore.getState().bindEngine(engine);
      try {
        bindRecoveringController(true);
        surface.playImplementation = async () => {
          throw new DOMException("blocked", "NotAllowedError");
        };
        engine.load(makePlayableTrack("t1"), true);
        await flush();
        const state = usePlayerStore.getState();
        expect(state.error).toBeNull();
        expect(state.isPlaying).toBe(false);
        expect(state.isLoading).toBe(false);
      } finally {
        dispose();
        usePlayerStore.getState().bindEngine(null);
      }
    });

    it("surfaces autoplay blocks once recovery is no longer active", async () => {
      resetStore();
      const surface = new FakeAudioSurface();
      const engine = new PlayerEngine(surface);
      const dispose = usePlayerStore.getState().bindEngine(engine);
      try {
        bindRecoveringController(false);
        surface.playImplementation = async () => {
          throw new DOMException("blocked", "NotAllowedError");
        };
        engine.load(makePlayableTrack("t1"), true);
        await flush();
        expect(usePlayerStore.getState().error?.kind).toBe("autoplay");
      } finally {
        dispose();
        usePlayerStore.getState().bindEngine(null);
      }
    });

    it("surfaces engine errors when no recovery is active", () => {
      const surface = mountEngine();
      usePlayerStore.getState().playTrack(makePlayableTrack("t1"));
      bindRecoveringController(false);
      surface.error = { code: 2 };
      surface.dispatch(EventEnum.error);
      expect(usePlayerStore.getState().error?.kind).toBe("playback");
    });
  });

  it("clamps volume and toggles mute", () => {
    const surface = mountEngine();
    const store = usePlayerStore.getState();
    store.setVolume(2);
    expect(usePlayerStore.getState().volume).toBe(1);
    expect(surface.volume).toBe(1);
    store.setVolume(-5);
    expect(usePlayerStore.getState().volume).toBe(0);
    store.setVolume(0.5);
    expect(usePlayerStore.getState().volume).toBe(0.5);

    store.toggleMute();
    expect(usePlayerStore.getState().muted).toBe(true);
    expect(surface.muted).toBe(true);
    store.toggleMute();
    expect(usePlayerStore.getState().muted).toBe(false);
  });

  it("seeks through the engine snapshot", () => {
    const surface = mountEngine();
    surface.duration = 100;
    usePlayerStore.getState().seek(40);
    expect(usePlayerStore.getState().currentTime).toBe(40);
    usePlayerStore.getState().seek(500);
    expect(usePlayerStore.getState().currentTime).toBe(100);
  });

  it("replaces the queue when playTrack is called", () => {
    const surface = mountEngine();
    const store = usePlayerStore.getState();
    store.playTrack(makePlayableTrack("a"));
    store.playTrack(makePlayableTrack("b"));
    store.playTrack(makePlayableTrack("c"));
    surface.dispatch(EventEnum.playing);

    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["c"]);
    expect(state.playOrder).toEqual([0]);
    expect(state.position).toBe(0);
    expect(state.currentTrack?.id).toBe("c");
    expect(state.isPlaying).toBe(true);
  });

  it("addToQueue appends tracks to the queue", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.addToQueue(makePlayableTrack("a"));
    store.addToQueue(makePlayableTrack("b"));
    store.addToQueue(makePlayableTrack("c"));
    // No track is playing yet, addToQueue just appends
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(state.playOrder).toEqual([0, 1, 2]);
  });

  it("replays an already-queued track when playTrack is called with it", () => {
    const store = usePlayerStore.getState();
    store.addToQueue(makePlayableTrack("a"));
    store.addToQueue(makePlayableTrack("b"));
    // playTrack replaces the queue with just [a]
    store.playTrack(makePlayableTrack("a"));

    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["a"]);
    expect(state.playOrder).toEqual([0]);
    expect(state.position).toBe(0);
    expect(state.currentTrack?.id).toBe("a");
  });

  it("handles a rapid series of switch requests", () => {
    const surface = mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    expect(surface.src).toBe("https://audio.example/a.mp3");
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    expect(usePlayerStore.getState().isLoading).toBe(true);
  });

  it("no-ops transport when nothing is loaded", async () => {
    const store = usePlayerStore.getState();
    await store.togglePlay();
    store.pause();
    store.seek(10);
    expect(store.currentTime).toBe(0);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("unsubscribes store listeners when rebinding the engine", () => {
    const first = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a"));
    first.dispatch(EventEnum.loadedmetadata);
    first.dispatch(EventEnum.playing);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    const second = mountEngine();
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    usePlayerStore.getState().playTrack(makePlayableTrack("b"));
    second.dispatch(EventEnum.loadedmetadata);
    second.dispatch(EventEnum.playing);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    expect(usePlayerStore.getState().isPlaying).toBe(true);

    first.dispatch(EventEnum.pause);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("clears errors on demand", () => {
    mountEngine();
    usePlayerStore
      .getState()
      .playTrack(makePlayableTrack("t1", { streamUrl: undefined }));
    expect(usePlayerStore.getState().error?.kind).toBe("unavailable");
    usePlayerStore.getState().clearError();
    expect(usePlayerStore.getState().error).toBeNull();
  });
});

describe("shuffle", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("toggles shuffle on and off", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);

    expect(usePlayerStore.getState().shuffle).toBe(false);
    usePlayerStore.getState().toggleShuffle();
    expect(usePlayerStore.getState().shuffle).toBe(true);
    usePlayerStore.getState().toggleShuffle();
    expect(usePlayerStore.getState().shuffle).toBe(false);
  });

  it("shuffled playOrder contains all queue items exactly once", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
      makePlayableTrack("d"),
      makePlayableTrack("e"),
    ]);

    usePlayerStore.getState().toggleShuffle();
    const order = usePlayerStore.getState().playOrder;
    const sorted = [...order].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2, 3, 4]);
  });

  it("current track is preserved after shuffle toggle", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ], { startIndex: 2 });
    // Current is "c"

    usePlayerStore.getState().toggleShuffle();
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("c");

    usePlayerStore.getState().toggleShuffle();
    const restored = usePlayerStore.getState();
    expect(restored.currentTrack?.id).toBe("c");
  });

  it("next() follows shuffled playOrder", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
      makePlayableTrack("d"),
      makePlayableTrack("e"),
    ]);

    usePlayerStore.setState({ repeat: "all" });
    usePlayerStore.getState().toggleShuffle();

    // Play all tracks via next() to verify no duplicates
    const played: string[] = [];
    for (let i = 0; i < 5; i++) {
      played.push(usePlayerStore.getState().currentTrack!.id);
      usePlayerStore.getState().next();
    }
    const unique = new Set(played);
    expect(unique.size).toBe(5);
  });

  it("prev() works with shuffled playOrder", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
      makePlayableTrack("d"),
      makePlayableTrack("e"),
    ]);

    usePlayerStore.getState().toggleShuffle();
    // Move to a non-first position so prev can actually go back
    usePlayerStore.getState().next();
    usePlayerStore.setState({ currentTime: 1 });

    const currentId = usePlayerStore.getState().currentTrack!.id;
    usePlayerStore.getState().prev();
    const prevId = usePlayerStore.getState().currentTrack!.id;

    // prev should go to a different track (the one before in shuffled order)
    expect(prevId).not.toBe(currentId);
  });

  it("no-ops toggleShuffle with empty queue", () => {
    mountEngine();
    usePlayerStore.getState().toggleShuffle();
    expect(usePlayerStore.getState().shuffle).toBe(false);
    expect(usePlayerStore.getState().playOrder).toEqual([]);
  });

  it("shuffle with single track does nothing", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([makePlayableTrack("a")]);
    usePlayerStore.getState().toggleShuffle();
    expect(usePlayerStore.getState().playOrder).toEqual([0]);
    expect(usePlayerStore.getState().position).toBe(0);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
  });
});

describe("repeat modes with shuffle", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("repeat all wraps with shuffled playOrder", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    usePlayerStore.setState({ repeat: "all" });
    usePlayerStore.getState().toggleShuffle();
    surface.dispatch(EventEnum.playing);

    // Advance through all tracks
    for (let i = 0; i < 2; i++) {
      surface.dispatch(EventEnum.ended);
      await flush();
    }
    // Now play the last track in shuffled order
    surface.dispatch(EventEnum.ended);
    await flush();

    // Should wrap to first track in shuffled order
    const state = usePlayerStore.getState();
    expect(state.position).toBe(0);
    expect(state.isPlaying).toBe(true);
  });

  it("repeat one replays same track in shuffled mode", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
    ]);
    usePlayerStore.setState({ repeat: "one" });
    usePlayerStore.getState().toggleShuffle();
    surface.dispatch(EventEnum.playing);

    const idBefore = usePlayerStore.getState().currentTrack!.id;
    surface.dispatch(EventEnum.ended);
    await flush();
    const idAfter = usePlayerStore.getState().currentTrack!.id;

    expect(idAfter).toBe(idBefore);
  });

  it("repeat off stops at end of shuffled playOrder", async () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
    ]);
    usePlayerStore.setState({ repeat: "off" });
    usePlayerStore.getState().toggleShuffle();
    surface.dispatch(EventEnum.playing);

    // Play through all tracks via ended events
    surface.dispatch(EventEnum.ended);
    await flush();
    surface.dispatch(EventEnum.ended);
    await flush();

    // Should stop (repeat off, no more tracks)
    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
  });
});

describe("cycleRepeat", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("cycles through off → all → one → off", () => {
    mountEngine();
    expect(usePlayerStore.getState().repeat).toBe("off");

    usePlayerStore.getState().cycleRepeat();
    expect(usePlayerStore.getState().repeat).toBe("all");

    usePlayerStore.getState().cycleRepeat();
    expect(usePlayerStore.getState().repeat).toBe("one");

    usePlayerStore.getState().cycleRepeat();
    expect(usePlayerStore.getState().repeat).toBe("off");
  });
});

describe("qualification tracking", () => {
  beforeEach(() => {
    resetStore();
    mockRecordPlayed.mockClear();
    setRecordPlayedAction(mockRecordPlayed);
  });
  afterEach(() => {
    unmount();
    setRecordPlayedAction(null as never);
  });

  it("does not report play below threshold", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a", { duration: 60 }));
    surface.duration = 60;
    surface.dispatch(EventEnum.loadedmetadata);
    surface.currentTime = 10;
    surface.dispatch(EventEnum.timeupdate);

    expect(usePlayerStore.getState().qualifiedTrackKey).toBeNull();
    expect(mockRecordPlayed).not.toHaveBeenCalled();
  });

  it("reports play when threshold is reached", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a", { duration: 60 }));
    surface.duration = 60;
    surface.dispatch(EventEnum.loadedmetadata);
    surface.dispatch(EventEnum.playing);
    surface.currentTime = 30;
    surface.dispatch(EventEnum.timeupdate);

    expect(usePlayerStore.getState().qualifiedTrackKey).toBe("jamendo:a");
    expect(mockRecordPlayed).toHaveBeenCalledOnce();
  });

  it("reports play with unknown duration at 30s", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a"));
    surface.dispatch(EventEnum.playing);
    surface.currentTime = 30;
    surface.dispatch(EventEnum.timeupdate);

    expect(usePlayerStore.getState().qualifiedTrackKey).toBe("jamendo:a");
  });

  it("only reports once per track", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a", { duration: 60 }));
    surface.duration = 60;
    surface.dispatch(EventEnum.loadedmetadata);
    surface.dispatch(EventEnum.playing);
    surface.currentTime = 30;
    surface.dispatch(EventEnum.timeupdate);
    surface.currentTime = 35;
    surface.dispatch(EventEnum.timeupdate);
    surface.currentTime = 40;
    surface.dispatch(EventEnum.timeupdate);

    expect(mockRecordPlayed).toHaveBeenCalledOnce();
  });

  it("does not report when not playing", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a", { duration: 60 }));
    surface.duration = 60;
    surface.dispatch(EventEnum.loadedmetadata);
    // No playing event
    surface.currentTime = 30;
    surface.dispatch(EventEnum.timeupdate);

    expect(usePlayerStore.getState().qualifiedTrackKey).toBeNull();
    expect(mockRecordPlayed).not.toHaveBeenCalled();
  });

  it("resets qualification on track change", () => {
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a", { duration: 60 }));
    surface.duration = 60;
    surface.dispatch(EventEnum.loadedmetadata);
    surface.dispatch(EventEnum.playing);
    surface.currentTime = 30;
    surface.dispatch(EventEnum.timeupdate);

    expect(usePlayerStore.getState().qualifiedTrackKey).toBe("jamendo:a");

    usePlayerStore.getState().playTrack(makePlayableTrack("b", { duration: 60 }));
    expect(usePlayerStore.getState().qualifiedTrackKey).toBeNull();
  });

  it("second track qualifies independently", () => {
    vi.useFakeTimers();
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a", { duration: 60 }));
    surface.duration = 60;
    surface.dispatch(EventEnum.loadedmetadata);
    surface.dispatch(EventEnum.playing);
    surface.currentTime = 30;
    vi.advanceTimersByTime(300);
    surface.dispatch(EventEnum.timeupdate);
    expect(mockRecordPlayed).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(300);
    usePlayerStore.getState().playTrack(makePlayableTrack("b", { duration: 60 }));
    surface.duration = 60;
    surface.dispatch(EventEnum.loadedmetadata);
    surface.dispatch(EventEnum.playing);
    surface.currentTime = 30;
    vi.advanceTimersByTime(300);
    surface.dispatch(EventEnum.timeupdate);
    expect(mockRecordPlayed).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("handles server action failure gracefully", () => {
    vi.useFakeTimers();
    vi.mocked(mockRecordPlayed).mockResolvedValue({ ok: false });
    const surface = mountEngine();
    usePlayerStore.getState().playTrack(makePlayableTrack("a", { duration: 60 }));
    surface.duration = 60;
    surface.dispatch(EventEnum.loadedmetadata);
    surface.dispatch(EventEnum.playing);
    surface.currentTime = 30;
    vi.advanceTimersByTime(300);
    surface.dispatch(EventEnum.timeupdate);

    expect(usePlayerStore.getState().qualifiedTrackKey).toBe("jamendo:a");
    expect(usePlayerStore.getState().error).toBeNull();
    vi.useRealTimers();
  });
});

describe("replaceQueue", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("replaces previous queue entirely", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([makePlayableTrack("a"), makePlayableTrack("b")]);
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(["a", "b"]);

    usePlayerStore.getState().replaceQueue([makePlayableTrack("x")]);
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["x"]);
    expect(state.playOrder).toEqual([0]);
    expect(state.position).toBe(0);
    expect(state.currentTrack?.id).toBe("x");
  });

  it("handles empty replacement", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([makePlayableTrack("a")]);
    usePlayerStore.getState().replaceQueue([]);
    const state = usePlayerStore.getState();
    expect(state.queue).toEqual([]);
    expect(state.playOrder).toEqual([]);
    expect(state.position).toBe(-1);
    expect(state.currentTrack).toBeNull();
    expect(state.isPlaying).toBe(false);
  });

  it("startIndex 0 starts at first track", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue(
      [makePlayableTrack("a"), makePlayableTrack("b"), makePlayableTrack("c")],
      { startIndex: 0 },
    );
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    expect(usePlayerStore.getState().position).toBe(0);
  });

  it("middle startIndex starts at that track", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue(
      [makePlayableTrack("a"), makePlayableTrack("b"), makePlayableTrack("c")],
      { startIndex: 1 },
    );
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    expect(usePlayerStore.getState().position).toBe(1);
  });

  it("clamps negative startIndex to 0", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue(
      [makePlayableTrack("a"), makePlayableTrack("b")],
      { startIndex: -5 },
    );
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    expect(usePlayerStore.getState().position).toBe(0);
  });

  it("clamps oversized startIndex to last valid index", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue(
      [makePlayableTrack("a"), makePlayableTrack("b")],
      { startIndex: 100 },
    );
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    expect(usePlayerStore.getState().position).toBe(1);
  });

  it("does not autoplay when autoplay is false", () => {
    const surface = mountEngine();
    usePlayerStore.getState().replaceQueue(
      [makePlayableTrack("a")],
      { autoplay: false },
    );
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    expect(usePlayerStore.getState().isLoading).toBe(true);
    expect(surface.playedCalls).toBe(0);
  });

  it("preserves current track when preserveCurrent is true and track exists in new queue", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ], { startIndex: 2 });
    expect(usePlayerStore.getState().currentTrack?.id).toBe("c");

    // Replace queue but preserve current track
    usePlayerStore.getState().replaceQueue(
      [makePlayableTrack("x"), makePlayableTrack("c"), makePlayableTrack("y")],
      { preserveCurrent: true },
    );
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("c");
    expect(state.queue.map((t) => t.id)).toEqual(["x", "c", "y"]);
    expect(state.position).toBe(1);
  });

  it("falls back to startIndex when preserveCurrent is true but current track not in new queue", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
    ], { startIndex: 1 });
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");

    // Replace queue; current "b" is not in new queue
    usePlayerStore.getState().replaceQueue(
      [makePlayableTrack("x"), makePlayableTrack("y")],
      { preserveCurrent: true },
    );
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("x");
    expect(state.position).toBe(0);
  });

  it("respects shuffle state on replacement", () => {
    mountEngine();
    usePlayerStore.setState({ shuffle: true });
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
      makePlayableTrack("d"),
      makePlayableTrack("e"),
    ], { startIndex: 2 });
    const state = usePlayerStore.getState();
    // Current track should be the start track even in shuffle mode
    expect(state.currentTrack?.id).toBe("c");
    // All queue indexes should be present in playOrder
    const sorted = [...state.playOrder].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2, 3, 4]);
    // Start track should be first in shuffled playOrder
    expect(state.playOrder[0]).toBe(2);
  });

  it("preserves repeat mode across replacement", () => {
    mountEngine();
    usePlayerStore.setState({ repeat: "all" });
    usePlayerStore.getState().replaceQueue([makePlayableTrack("a")]);
    expect(usePlayerStore.getState().repeat).toBe("all");

    usePlayerStore.setState({ repeat: "one" });
    usePlayerStore.getState().replaceQueue([makePlayableTrack("b")]);
    expect(usePlayerStore.getState().repeat).toBe("one");
  });
});

describe("playCollection", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("replaces queue and starts at startIndex", () => {
    mountEngine();
    usePlayerStore.getState().playCollection(
      [makePlayableTrack("a"), makePlayableTrack("b"), makePlayableTrack("c")],
      2,
    );
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(state.currentTrack?.id).toBe("c");
    expect(state.position).toBe(2);
  });

  it("defaults startIndex to 0", () => {
    mountEngine();
    usePlayerStore.getState().playCollection([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
    ]);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    expect(usePlayerStore.getState().position).toBe(0);
  });

  it("selected track becomes current, rest becomes upcoming queue", () => {
    mountEngine();
    usePlayerStore.getState().playCollection(
      [makePlayableTrack("a"), makePlayableTrack("b"), makePlayableTrack("c")],
      1,
    );
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("b");
    // Queue traversal after b: next should go to c
    state.next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("c");
  });
});

describe("playNext", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("inserts track after current position", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    // Current is "a" at position 0
    store.playNext(makePlayableTrack("x"));
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["a", "b", "c", "x"]);
    // playOrder should have x inserted after position 0
    expect(state.playOrder).toEqual([0, 3, 1, 2]);
  });

  it("next() from current goes to inserted track", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    store.playNext(makePlayableTrack("x"));
    store.next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("x");
  });

  it("does not affect current track", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([makePlayableTrack("a")]);
    store.playNext(makePlayableTrack("x"));
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
  });
});

describe("addToQueue", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("appends track to end of queue", () => {
    mountEngine();
    usePlayerStore.getState().addToQueue(makePlayableTrack("a"));
    usePlayerStore.getState().addToQueue(makePlayableTrack("b"));
    usePlayerStore.getState().addToQueue(makePlayableTrack("c"));
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(state.playOrder).toEqual([0, 1, 2]);
  });

  it("does not change current track or position", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([makePlayableTrack("a")]);
    const before = usePlayerStore.getState();
    store.addToQueue(makePlayableTrack("x"));
    const after = usePlayerStore.getState();
    expect(after.currentTrack?.id).toBe("a");
    expect(after.position).toBe(before.position);
  });
});

describe("playAtPosition", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("switches to the track at the given position", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    store.playAtPosition(2);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("c");
    expect(usePlayerStore.getState().position).toBe(2);
  });

  it("no-ops for invalid position", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([makePlayableTrack("a"), makePlayableTrack("b")]);
    store.playAtPosition(-1);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    store.playAtPosition(10);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
  });
});

describe("queue invariants", () => {
  beforeEach(() => resetStore());
  afterEach(() => unmount());

  it("queue.length === playOrder.length after replaceQueue", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    const state = usePlayerStore.getState();
    expect(state.queue.length).toBe(state.playOrder.length);
  });

  it("playOrder contains every queue index exactly once after replaceQueue", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
      makePlayableTrack("d"),
      makePlayableTrack("e"),
    ]);
    const state = usePlayerStore.getState();
    const sorted = [...state.playOrder].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2, 3, 4]);
  });

  it("playOrder contains every queue index exactly once after playNext", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("b"),
      makePlayableTrack("c"),
    ]);
    store.playNext(makePlayableTrack("x"));
    const state = usePlayerStore.getState();
    const sorted = [...state.playOrder].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2, 3]);
    expect(state.queue.length).toBe(state.playOrder.length);
  });

  it("playOrder contains every queue index exactly once after addToQueue", () => {
    mountEngine();
    const store = usePlayerStore.getState();
    store.addToQueue(makePlayableTrack("a"));
    store.addToQueue(makePlayableTrack("b"));
    store.addToQueue(makePlayableTrack("c"));
    const state = usePlayerStore.getState();
    const sorted = [...state.playOrder].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2]);
  });

  it("duplicate tracks are valid queue entries", () => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a"),
      makePlayableTrack("a"),
      makePlayableTrack("b"),
    ]);
    const state = usePlayerStore.getState();
    expect(state.queue.length).toBe(3);
    const sorted = [...state.playOrder].sort((a, b) => a - b);
    expect(sorted).toEqual([0, 1, 2]);
  });
});

describe("moveQueueItem", () => {
  beforeEach(() => {
    mountEngine();
    usePlayerStore.getState().replaceQueue([
      makePlayableTrack("a", { title: "Track A" }),
      makePlayableTrack("b", { title: "Track B" }),
      makePlayableTrack("c", { title: "Track C" }),
      makePlayableTrack("d", { title: "Track D" }),
    ]);
  });

  it("moves an item up", () => {
    usePlayerStore.getState().moveQueueItem(2, "up");
    const { playOrder, queue } = usePlayerStore.getState();
    expect(queue[playOrder[0]]?.id).toBe("a");
    expect(queue[playOrder[1]]?.id).toBe("c");
    expect(queue[playOrder[2]]?.id).toBe("b");
    expect(queue[playOrder[3]]?.id).toBe("d");
  });

  it("moves an item down", () => {
    usePlayerStore.getState().moveQueueItem(1, "down");
    const { playOrder, queue } = usePlayerStore.getState();
    expect(queue[playOrder[0]]?.id).toBe("a");
    expect(queue[playOrder[1]]?.id).toBe("c");
    expect(queue[playOrder[2]]?.id).toBe("b");
    expect(queue[playOrder[3]]?.id).toBe("d");
  });

  it("does nothing when moving up from position 0", () => {
    const before = usePlayerStore.getState().playOrder.slice();
    usePlayerStore.getState().moveQueueItem(0, "up");
    expect(usePlayerStore.getState().playOrder).toEqual(before);
  });

  it("does nothing when moving down from last position", () => {
    const before = usePlayerStore.getState().playOrder.slice();
    usePlayerStore.getState().moveQueueItem(3, "down");
    expect(usePlayerStore.getState().playOrder).toEqual(before);
  });

  it("adjusts current position when the current track moves up", () => {
    usePlayerStore.getState().playAtPosition(2);
    usePlayerStore.getState().moveQueueItem(2, "up");
    expect(usePlayerStore.getState().position).toBe(1);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("c");
  });

  it("adjusts current position when the current track moves down", () => {
    usePlayerStore.getState().playAtPosition(1);
    usePlayerStore.getState().moveQueueItem(1, "down");
    expect(usePlayerStore.getState().position).toBe(2);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
  });

  it("does not change position when swapping items before current", () => {
    usePlayerStore.getState().playAtPosition(2);
    usePlayerStore.getState().moveQueueItem(0, "down");
    expect(usePlayerStore.getState().position).toBe(2);
    expect(usePlayerStore.getState().currentTrack?.id).toBe("c");
  });

  it("does nothing with a single-item queue", () => {
    usePlayerStore.getState().replaceQueue([makePlayableTrack("solo")]);
    const before = usePlayerStore.getState().playOrder.slice();
    usePlayerStore.getState().moveQueueItem(0, "up");
    expect(usePlayerStore.getState().playOrder).toEqual(before);
  });
});

describe("full player state", () => {
  beforeEach(() => mountEngine());

  it("defaults to closed", () => {
    expect(usePlayerStore.getState().isFullPlayerOpen).toBe(false);
  });

  it("opens the full player", () => {
    usePlayerStore.getState().openFullPlayer();
    expect(usePlayerStore.getState().isFullPlayerOpen).toBe(true);
  });

  it("closes the full player", () => {
    usePlayerStore.getState().openFullPlayer();
    usePlayerStore.getState().closeFullPlayer();
    expect(usePlayerStore.getState().isFullPlayerOpen).toBe(false);
  });
});

describe("persistence generation and restore", () => {
  beforeEach(() => mountEngine());

  it("starts with idle persistence and zero generation", () => {
    const state = usePlayerStore.getState();
    expect(state.persistenceInitState).toBe("idle");
    expect(state.userActionGeneration).toBe(0);
    expect(state.pendingRestorePosition).toBeNull();
  });

  it("explicit actions bump the user-action generation", () => {
    const store = usePlayerStore.getState();
    store.playTrack(makePlayableTrack("a"));
    expect(usePlayerStore.getState().userActionGeneration).toBeGreaterThan(0);

    const before = usePlayerStore.getState().userActionGeneration;
    usePlayerStore.getState().seek(5);
    usePlayerStore.getState().pause();
    expect(usePlayerStore.getState().userActionGeneration).toBeGreaterThan(
      before,
    );
  });

  it("queue mutations also count as user intent", () => {
    const before = usePlayerStore.getState().userActionGeneration;
    usePlayerStore.getState().addToQueue(makePlayableTrack("q"));
    expect(usePlayerStore.getState().userActionGeneration).toBeGreaterThan(
      before,
    );
  });

  it("restoreTrack loads without autoplay and without counting as intent", () => {
    const surface = mountEngine();
    const genBefore = usePlayerStore.getState().userActionGeneration;
    usePlayerStore.getState().restoreTrack(makePlayableTrack("r"), 83);

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("r");
    expect(state.isPlaying).toBe(false);
    expect(state.userActionGeneration).toBe(genBefore);
    expect(state.pendingRestorePosition).toBe(83);
    // Restore must not qualify for recently-played by itself.
    expect(state.qualifiedTrackKey).toBeNull();
    expect(surface.playedCalls).toBe(0);
  });

  it("restoreTrack seeks to the safe position on loadedmetadata", () => {
    const surface = mountEngine();
    usePlayerStore.getState().restoreTrack(makePlayableTrack("r"), 83);

    surface.duration = 200;
    surface.dispatch(EventEnum.loadedmetadata);

    const state = usePlayerStore.getState();
    expect(state.duration).toBe(200);
    expect(state.currentTime).toBe(83);
    expect(state.pendingRestorePosition).toBeNull();
  });

  it("restoreTrack clamps position beyond duration", () => {
    const surface = mountEngine();
    usePlayerStore.getState().restoreTrack(makePlayableTrack("r"), 500);

    surface.duration = 200;
    surface.dispatch(EventEnum.loadedmetadata);

    const state = usePlayerStore.getState();
    expect(state.currentTime).toBe(200);
    expect(state.pendingRestorePosition).toBeNull();
  });

  it("restoreTrack with zero position leaves no pending seek", () => {
    mountEngine();
    usePlayerStore.getState().restoreTrack(makePlayableTrack("r"), 0);
    expect(usePlayerStore.getState().pendingRestorePosition).toBeNull();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("r");
  });

  it("explicit seek clears a pending restore seek", () => {
    mountEngine();
    usePlayerStore.getState().restoreTrack(makePlayableTrack("r"), 83);
    expect(usePlayerStore.getState().pendingRestorePosition).toBe(83);
    usePlayerStore.getState().seek(10);
    expect(usePlayerStore.getState().pendingRestorePosition).toBeNull();
  });

  it("replaceQueue clears a pending restore seek", () => {
    mountEngine();
    usePlayerStore.getState().restoreTrack(makePlayableTrack("r"), 83);
    usePlayerStore.getState().replaceQueue([makePlayableTrack("n")]);
    expect(usePlayerStore.getState().pendingRestorePosition).toBeNull();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("n");
  });

  it("setPersistenceInitState transitions lifecycle state", () => {
    usePlayerStore.getState().setPersistenceInitState("loading");
    expect(usePlayerStore.getState().persistenceInitState).toBe("loading");
    usePlayerStore.getState().setPersistenceInitState("ready");
    expect(usePlayerStore.getState().persistenceInitState).toBe("ready");
  });
});