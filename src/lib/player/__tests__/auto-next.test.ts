import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerEngine } from "@/lib/player/engine";
import { usePlayerStore, setPlaybackController } from "@/lib/player/store";
import { createPlaybackController } from "@/lib/playback/controller";
import { controllableResolver } from "@/lib/playback/__tests__/fake-controller-env";
import { EventEnum, FakeAudioSurface } from "./fake-audio";
import type { Track } from "@/lib/domain";

/**
 * Playlist auto-next regression (Phase 47, §33–§38, §71).
 *
 * The reported bug was that playing a playlist stopped after one track
 * instead of continuing. The root cause was fixed in Phase 46 in
 * `PlaybackController.onEnded` (`src/lib/playback/controller.ts`): the
 * store's own `ended` handler is subscribed first and advances the queue
 * synchronously, claiming a NEWER generation that carries autoplay intent;
 * the controller's `ended` handler then ran for the OLD generation and
 * cleared `wantPlay`, so the freshly advanced track loaded but stayed
 * paused. Gapless advance was broken on every natural transition.
 *
 * Phase 47 adds NO fix here — the behaviour was already correct. What it
 * adds is the coverage Phase 46 lacked: the previous regression only
 * asserted ONE advance from a three-track queue, which cannot catch a
 * second transition going wrong. These tests drive two natural ends through
 * the full real stack, so a break anywhere in
 * `ended -> PlayerEngine -> PlaybackController -> store.loadAt -> engine`
 * shows up.
 *
 * Determinism: every transition is driven by dispatching the media element's
 * own `ended` event and awaiting MICROtasks only. No clock is advanced, no
 * real time is waited, and no timer is relied upon. If auto-advance depended
 * on a timer, `flush()` would return before the transition and these tests
 * would fail — which is exactly why a "setTimeout" fix could not satisfy
 * them.
 */

function youtubeTrack(id: string): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: "UC1",
    artistName: `Artist ${id}`,
  };
}

/** Microtasks only. No timers, no waits, no real-time dependency. */
async function flush() {
  for (let i = 0; i < 12; i += 1) {
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

describe("playlist auto-next (Phase 47 regression)", () => {
  let surface: FakeAudioSurface;
  let disposeEngine: (() => void) | null = null;
  let disposeController: (() => void) | null = null;
  let backend: ReturnType<typeof controllableResolver>;

  beforeEach(() => {
    resetStore();
    surface = new FakeAudioSurface();
    const engine = new PlayerEngine(surface);
    disposeEngine = usePlayerStore.getState().bindEngine(engine);
    backend = controllableResolver();
    // Every identity resolves, so a track is playable and the test is not
    // silently passing because resolution failed.
    backend.resolveSource.mockImplementation(async (ref) => ({
      url: `https://cdn.example/${ref.id}.m4a`,
    }));
    const controller = createPlaybackController({
      resolver: backend.resolver,
      engine,
      reportError: (error) => {
        usePlayerStore.getState().reportPlaybackError(error.kind, error.message);
      },
    });
    setPlaybackController(controller);
    disposeController = () => {
      controller.shutdown();
      setPlaybackController(null);
    };
  });

  afterEach(() => {
    disposeController?.();
    disposeController = null;
    disposeEngine?.();
    disposeEngine = null;
    usePlayerStore.getState().bindEngine(null);
    setPlaybackController(null);
    resetStore();
  });

  it("advances A -> B -> C across two natural ends, playing each track", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
      youtubeTrack("ccccccccccc"),
    ]);
    await flush();
    expect(surface.playedCalls).toBe(1);

    // --- first natural end: A -> B ---
    surface.dispatch(EventEnum.ended);
    await flush();
    let state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("bbbbbbbbbbb");
    expect(state.position).toBe(1);
    expect(surface.src).toBe("https://cdn.example/bbbbbbbbbbb.m4a");
    // The load must have AUTOPLAYED, not merely loaded. This is the exact
    // assertion the original bug violated: `playedCalls` did not advance and
    // the element was left paused.
    expect(surface.playedCalls).toBe(2);
    expect(surface.paused).toBe(false);
    expect(state.isPlaying).toBe(true);

    // --- second natural end: B -> C ---
    surface.dispatch(EventEnum.ended);
    await flush();
    state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("ccccccccccc");
    expect(state.position).toBe(2);
    expect(surface.src).toBe("https://cdn.example/ccccccccccc.m4a");
    expect(surface.playedCalls).toBe(3);
    expect(surface.paused).toBe(false);
    expect(state.isPlaying).toBe(true);

    // --- third natural end: end of the queue stops, and nothing loops ---
    surface.dispatch(EventEnum.ended);
    await flush();
    state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.isLoading).toBe(false);
    // The last track stays current; the queue is not rewound.
    expect(state.currentTrack?.id).toBe("ccccccccccc");
    expect(state.position).toBe(2);
    expect(surface.playedCalls).toBe(3);
  });

  it("stops cleanly on a single-track queue", async () => {
    usePlayerStore.getState().replaceQueue([youtubeTrack("aaaaaaaaaaa")]);
    await flush();
    expect(surface.playedCalls).toBe(1);

    surface.dispatch(EventEnum.ended);
    await flush();

    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.queue).toHaveLength(1);
    expect(state.currentTrack?.id).toBe("aaaaaaaaaaa");
    // No phantom second load.
    expect(surface.playedCalls).toBe(1);
  });

  it("ignores an ended event with an empty queue", async () => {
    // An empty queue has nothing to advance and nothing to stop. A stray
    // media `ended` must be a no-op, not a throw and not a phantom load.
    expect(() => surface.dispatch(EventEnum.ended)).not.toThrow();
    await flush();

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual([]);
    expect(state.currentTrack).toBeNull();
    expect(state.isPlaying).toBe(false);
    expect(surface.playedCalls).toBe(0);
  });

  it("wraps under repeat all and keeps advancing", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
    ]);
    // cycleRepeat walks off -> all -> one -> off.
    usePlayerStore.getState().cycleRepeat();
    expect(usePlayerStore.getState().repeat).toBe("all");
    await flush();

    surface.dispatch(EventEnum.ended);
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("bbbbbbbbbbb");

    surface.dispatch(EventEnum.ended);
    await flush();
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("aaaaaaaaaaa");
    expect(state.isPlaying).toBe(true);
  });

  it("holds position under repeat one instead of advancing", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
    ]);
    usePlayerStore.getState().cycleRepeat();
    usePlayerStore.getState().cycleRepeat();
    expect(usePlayerStore.getState().repeat).toBe("one");
    await flush();

    surface.dispatch(EventEnum.ended);
    await flush();

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("aaaaaaaaaaa");
    expect(state.position).toBe(0);
  });

  it("a manual next immediately before ended does not get double-advanced", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
      youtubeTrack("ccccccccccc"),
    ]);
    await flush();

    // The listener presses Next on the first track, then the track ends.
    usePlayerStore.getState().next();
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("bbbbbbbbbbb");

    surface.dispatch(EventEnum.ended);
    await flush();

    const state = usePlayerStore.getState();
    // One advance only: the manual Next was not compounded by the end event.
    expect(state.currentTrack?.id).toBe("ccccccccccc");
    expect(state.position).toBe(2);
  });

  // A `pause()` immediately followed by a synthetic `ended` is deliberately
  // NOT tested here. A paused media element never fires `ended` (the event
  // requires the element to have stopped having paused=false), so that
  // sequence is unreachable outside this file's synthetic dispatcher. Testing
  // it would be a false-positive: green tests protecting a state no listener
  // can reach. The reachable control-precedence cases are covered instead —
  // manual pause, manual next, manual prev, and an explicit end-of-queue next
  // all below.
  it("a manual next while paused autoplays the next track", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
    ]);
    await flush();

    usePlayerStore.getState().pause();
    await flush();
    expect(surface.paused).toBe(true);
    expect(usePlayerStore.getState().isPlaying).toBe(false);

    // An explicit Next is a user gesture and must win over the paused state:
    // it is the listener asking for the next track.
    usePlayerStore.getState().next();
    await flush();

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("bbbbbbbbbbb");
    expect(state.isPlaying).toBe(true);
    expect(surface.paused).toBe(false);
  });

  it("a manual next at the end of the queue stops instead of wrapping", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
    ]);
    await flush();
    usePlayerStore.getState().next();
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("bbbbbbbbbbb");

    // repeat is off: the last track must not roll back to the first.
    usePlayerStore.getState().next();
    await flush();

    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.currentTime).toBe(0);
    expect(state.currentTrack?.id).toBe("bbbbbbbbbbb");
    expect(surface.playedCalls).toBe(2);
  });

  it("a manual prev steps back and a prev at the head restarts", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
      youtubeTrack("ccccccccccc"),
    ]);
    await flush();
    usePlayerStore.getState().playAtPosition(2);
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("ccccccccccc");

    usePlayerStore.getState().prev();
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("bbbbbbbbbbb");

    // Already at the head: prev restarts the current track rather than
    // walking off the front of the queue.
    usePlayerStore.getState().prev();
    await flush();
    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("aaaaaaaaaaa");
    expect(state.position).toBe(0);
    expect(state.isPlaying).toBe(true);
  });

  it("an explicit stop ends the queue and a later ended stays stopped", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
    ]);
    await flush();

    usePlayerStore.getState().clearQueue();
    await flush();
    expect(usePlayerStore.getState().queue).toEqual([]);

    surface.dispatch(EventEnum.ended);
    await flush();

    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.currentTrack).toBeNull();
    expect(surface.playedCalls).toBe(1);
  });

  it("a queue replaced mid-playback is never auto-advanced past its end", async () => {
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
      youtubeTrack("ccccccccccc"),
    ]);
    await flush();

    // The listener starts something specific. The old continuation context
    // is gone: the new single-track queue must simply end.
    usePlayerStore.getState().replaceQueue([youtubeTrack("ddddddddddd")]);
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("ddddddddddd");

    surface.dispatch(EventEnum.ended);
    await flush();

    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.queue.map((track) => track.id)).toEqual(["ddddddddddd"]);
  });
});
