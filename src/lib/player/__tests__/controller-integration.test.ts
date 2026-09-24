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
