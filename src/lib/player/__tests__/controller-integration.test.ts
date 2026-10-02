import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PlayerEngine } from "@/lib/player/engine";
import {
  usePlayerStore,
  setPlaybackController,
} from "@/lib/player/store";
import { createPlaybackController } from "@/lib/playback/controller";
import {
  controllableResolver,
  sourceFor,
} from "@/lib/playback/__tests__/fake-controller-env";
import { EventEnum, FakeAudioSurface } from "./fake-audio";
import { PlaybackResolutionError } from "@/lib/domain";
import type { Track } from "@/lib/domain";

function youtubeTrack(id: string): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: "UC1",
    artistName: "Artist",
  };
}

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

describe("controller + store integration", () => {
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

  it("routes playTrack through resolution into the engine", async () => {
    backend.resolveNextWith(sourceFor("aaaaaaaaaaa", "https://cdn.example/a.m4a"));
    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    expect(usePlayerStore.getState().isLoading).toBe(true);
    await flush();
    expect(surface.src).toBe("https://cdn.example/a.m4a");
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);
  });

  it("completes the metadata flow after resolved load", async () => {
    backend.resolveNextWith(sourceFor("aaaaaaaaaaa", "https://cdn.example/a.m4a"));
    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await flush();
    surface.duration = 213;
    surface.dispatch(EventEnum.loadedmetadata);
    const state = usePlayerStore.getState();
    expect(state.duration).toBe(213);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("pause during resolution defeats pending autoplay", async () => {
    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    backend.resolveSource.mockImplementationOnce(() => gate);
    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    usePlayerStore.getState().pause();
    release({ url: "https://cdn.example/a.m4a" });
    await flush();
    expect(surface.playedCalls).toBe(0);
    expect(surface.src).toBe("https://cdn.example/a.m4a");
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("next() during resolution discards the stale result", async () => {
    const releases: Array<(source: { url: string }) => void> = [];
    backend.resolveSource.mockImplementation(
      () =>
        new Promise<{ url: string }>((resolve) => {
          releases.push(resolve);
        }),
    );
    const store = usePlayerStore.getState();
    store.replaceQueue([youtubeTrack("aaaaaaaaaaa"), youtubeTrack("bbbbbbbbbbb")]);
    store.next();
    expect(releases).toHaveLength(2);
    releases[1]?.({ url: "https://cdn.example/b.m4a" });
    await flush();
    releases[0]?.({ url: "https://cdn.example/a.m4a" });
    await flush();
    expect(surface.src).toBe("https://cdn.example/b.m4a");
    expect(usePlayerStore.getState().currentTrack?.id).toBe("bbbbbbbbbbb");
  });

  it("resolution failure keeps the queue structurally valid", async () => {
    backend.rejectNextWith(
      new PlaybackResolutionError(
        { provider: "youtube", providerTrackId: "aaaaaaaaaaa" },
        "resolve",
        "Video unavailable",
      ),
    );
    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await flush();
    const state = usePlayerStore.getState();
    expect(state.error).toEqual({ kind: "unavailable", message: "Video unavailable" });
    expect(state.queue).toHaveLength(1);
    expect(state.currentTrack?.id).toBe("aaaaaaaaaaa");
    expect(surface.src).toBe("");
  });

  it("ended advances the queue through resolution", async () => {
    backend.resolveSource.mockImplementation(async (ref) => ({
      url: `https://cdn.example/${ref.id}.m4a`,
    }));
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
    ]);
    await flush();
    expect(surface.src).toBe("https://cdn.example/aaaaaaaaaaa.m4a");
    surface.dispatch(EventEnum.ended);
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("bbbbbbbbbbb");
    expect(surface.src).toBe("https://cdn.example/bbbbbbbbbbb.m4a");
  });

  it("ended auto-advances into playback, not a paused load", async () => {
    // Regression: the store's `ended` handler is subscribed before the
    // controller's, so it claims a newer generation carrying autoplay intent
    // first. The controller must not clear that intent when its own `ended`
    // handler runs afterwards, or the advanced track loads paused and
    // gapless playback silently stops working.
    backend.resolveSource.mockImplementation(async (ref) => ({
      url: `https://cdn.example/${ref.id}.m4a`,
    }));
    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa"),
      youtubeTrack("bbbbbbbbbbb"),
    ]);
    await flush();
    // replaceQueue autoplays the first track, so this is the baseline.
    expect(surface.playedCalls).toBe(1);

    surface.dispatch(EventEnum.ended);
    await flush();

    expect(surface.src).toBe("https://cdn.example/bbbbbbbbbbb.m4a");
    expect(surface.playedCalls).toBe(2);
    expect(surface.paused).toBe(false);
  });

  it("restore loads paused and seeks after metadata", async () => {
    backend.resolveNextWith(sourceFor("aaaaaaaaaaa", "https://cdn.example/a.m4a"));
    usePlayerStore.getState().restoreTrack(youtubeTrack("aaaaaaaaaaa"), 30);
    await flush();
    expect(surface.src).toBe("https://cdn.example/a.m4a");
    expect(surface.playedCalls).toBe(0);
    surface.duration = 213;
    surface.dispatch(EventEnum.loadedmetadata);
    expect(surface.currentTime).toBe(30);
    expect(usePlayerStore.getState().userActionGeneration).toBe(0);
  });

  it("clearQueue stops a pending resolution", async () => {
    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    backend.resolveSource.mockImplementationOnce(() => gate);
    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    usePlayerStore.getState().clearQueue();
    release({ url: "https://cdn.example/a.m4a" });
    await flush();
    expect(surface.src).toBe("");
    expect(usePlayerStore.getState().currentTrack).toBeNull();
  });

  it("shows unavailable instead of playing a preview clip", async () => {
    // Phase 11: a Spotify-only track with a previewUrl is unresolvable and
    // the preview must never reach the engine. Queue stays structurally
    // valid; no automatic skip.
    const legacy: Track = {
      id: "sp-1",
      provider: "spotify",
      providerTrackId: "sp-1",
      title: "Song",
      artistId: "sa-1",
      artistName: "Artist",
      previewUrl: "https://preview.example/sp-1.mp3",
    };
    usePlayerStore.getState().playTrack(legacy);
    await flush();
    expect(surface.src).toBe("");
    const state = usePlayerStore.getState();
    expect(state.error).toEqual({
      kind: "unavailable",
      message: "No playable source in this identity",
    });
    expect(state.queue).toHaveLength(1);
    expect(state.currentTrack?.id).toBe("sp-1");
  });
});

describe("restored session resumes with a fresh source (Phase 43)", () => {
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

  function restoreSession(mediaPosition: number) {
    // Exactly what a validated persisted session looks like on restore:
    // identity-only entries, no source, no autoplay.
    usePlayerStore.getState().restoreQueueSnapshot({
      tracks: [youtubeTrack("aaaaaaaaaaa"), youtubeTrack("bbbbbbbbbbb")],
      playOrder: [1, 0],
      position: 0,
      shuffle: true,
      repeat: "all",
      mediaPosition,
      currentTrack: youtubeTrack("bbbbbbbbbbb"),
      volume: 0.75,
      muted: false,
    });
  }

  it("restores without resolving or autoplaying", () => {
    restoreSession(92);
    const state = usePlayerStore.getState();
    expect(backend.resolveSource).not.toHaveBeenCalled();
    expect(surface.src).toBe("");
    expect(surface.playedCalls).toBe(0);
    expect(state.isPlaying).toBe(false);
    // The queue and its order are live, not a cache.
    expect(state.queue.map((t) => t.id)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb"]);
    expect(state.playOrder).toEqual([1, 0]);
    expect(state.position).toBe(0);
    expect(state.shuffle).toBe(true);
    expect(state.repeat).toBe("all");
    expect(state.currentTrack?.id).toBe("bbbbbbbbbbb");
    expect(state.pendingRestorePosition).toBe(92);
  });

  it("resolves a fresh playable source on Play, never a persisted URL", async () => {
    restoreSession(92);
    backend.resolveNextWith(sourceFor("bbbbbbbbbbb", "https://cdn.example/fresh.m4a"));

    await usePlayerStore.getState().togglePlay();
    await flush();

    // Fresh resolution happened for the restored identity — plus one prefetch
    // for the next queue entry once playback started (repeat-all wraps to
    // `aaaaaaaaaaa`). The prefetch finds no stubbed resolution and vanishes
    // silently; it must never disturb the load it warms.
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    expect(backend.resolveSource).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "bbbbbbbbbbb" }),
    );
    expect(backend.resolveSource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "aaaaaaaaaaa" }),
    );
    expect(surface.src).toBe("https://cdn.example/fresh.m4a");
    expect(surface.playedCalls).toBe(1);
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("seeks to the saved position once the fresh source reports metadata", async () => {
    restoreSession(92);
    backend.resolveNextWith(sourceFor("bbbbbbbbbbb", "https://cdn.example/fresh.m4a"));
    await usePlayerStore.getState().togglePlay();
    await flush();

    surface.duration = 213;
    surface.dispatch(EventEnum.loadedmetadata);

    const state = usePlayerStore.getState();
    expect(state.duration).toBe(213);
    // Approximate resume (exact second is more than the spec requires).
    expect(state.currentTime).toBeGreaterThanOrEqual(88);
    expect(state.currentTime).toBeLessThanOrEqual(96);
    expect(state.pendingRestorePosition).toBeNull();
  });

  it("clamps a saved position that exceeds the real duration", async () => {
    restoreSession(5_000);
    backend.resolveNextWith(sourceFor("bbbbbbbbbbb", "https://cdn.example/fresh.m4a"));
    await usePlayerStore.getState().togglePlay();
    await flush();

    surface.duration = 213;
    surface.dispatch(EventEnum.loadedmetadata);

    const state = usePlayerStore.getState();
    expect(state.currentTime).toBeLessThanOrEqual(213);
    expect(state.error).toBeNull();
  });

  it("keeps the restored queue fully operable after resume", async () => {
    restoreSession(92);
    backend.resolveSource.mockImplementation(async (ref) => ({
      url: `https://cdn.example/${ref.id}.m4a`,
    }));

    // next() navigates the restored queue normally.
    usePlayerStore.getState().next();
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("aaaaaaaaaaa");
    expect(usePlayerStore.getState().position).toBe(1);

    // previous() returns to the cursor track.
    usePlayerStore.getState().prev();
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("bbbbbbbbbbb");

    // playAt jumps to an arbitrary restored position.
    usePlayerStore.getState().playAtPosition(1);
    await flush();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("aaaaaaaaaaa");

    // remove/move/clear still work on the restored queue. Removal
    // targets a playOrder position and never the current one.
    usePlayerStore.getState().removeFromQueue(0);
    expect(usePlayerStore.getState().queue).toHaveLength(1);
    usePlayerStore.getState().moveQueueItem(0, "up");
    expect(usePlayerStore.getState().queue).toHaveLength(1);
    usePlayerStore.getState().clearQueue();
    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(usePlayerStore.getState().currentTrack).toBeNull();
  });

  it("an unresolvable restored track does not invalidate the queue", async () => {
    restoreSession(92);
    backend.rejectNextWith(
      new PlaybackResolutionError(
        { provider: "youtube", providerTrackId: "bbbbbbbbbbb" },
        "resolve",
        "Video unavailable",
      ),
    );
    await usePlayerStore.getState().togglePlay();
    await flush();

    const state = usePlayerStore.getState();
    expect(state.error?.kind).toBe("unavailable");
    expect(state.queue).toHaveLength(2);
    expect(state.currentTrack?.id).toBe("bbbbbbbbbbb");
  });
});
