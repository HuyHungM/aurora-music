import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  usePlayerStore,
  setPlaybackController,
} from "@/lib/player/store";
import type { PlaybackController } from "@/lib/playback/controller";
import { PlayerEngine } from "@/lib/player/engine";
import { EventEnum, FakeAudioSurface, makePlayableTrack } from "./fake-audio";
import type { Track } from "@/lib/domain";

function stubController(overrides: Partial<PlaybackController> = {}): {
  prefetchTrack: ReturnType<typeof vi.fn<(track: Track) => void>>;
} {
  const prefetchTrack = vi.fn<(track: Track) => void>();
  setPlaybackController({
    loadTrack: () => undefined,
    ensurePlaying: async () => undefined,
    prefetchTrack: (track: Track) => {
      prefetchTrack(track);
    },
    pause: () => undefined,
    notifySeekRequest: () => undefined,
    stop: () => undefined,
    currentGeneration: () => 0,
    isRecovering: () => false,
    getRecoveryDiagnostics: () => ({
      phase: "idle" as const,
      trackKey: null,
      attemptsUsed: 0,
      maxAttempts: 2,
      lastFailureCategory: null,
      updatedAtMs: Date.now(),
    }),
    shutdown: () => undefined,
    ...overrides,
  });
  return { prefetchTrack };
}

function mountEngine(): { surface: FakeAudioSurface; dispose: () => void } {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  const dispose = usePlayerStore.getState().bindEngine(engine);
  return { surface, dispose };
}

beforeEach(() => {
  usePlayerStore.getState().clearQueue();
});

afterEach(() => {
  usePlayerStore.getState().bindEngine(null);
  setPlaybackController(null);
  vi.unstubAllGlobals();
});

describe("store next-track prefetch", () => {
  it("warms the next queue entry when the current track starts playing", () => {
    const { surface, dispose } = mountEngine();
    const { prefetchTrack } = stubController();
    try {
      const first = makePlayableTrack("t1");
      const second = makePlayableTrack("t2");
      usePlayerStore.getState().replaceQueue([first, second], { startIndex: 0 });
      surface.dispatch(EventEnum.playing);
      expect(prefetchTrack).toHaveBeenCalledTimes(1);
      expect(prefetchTrack).toHaveBeenCalledWith(second);
    } finally {
      dispose();
    }
  });

  it("does nothing when nothing plays next", () => {
    const { surface, dispose } = mountEngine();
    const { prefetchTrack } = stubController();
    try {
      usePlayerStore.getState().replaceQueue([makePlayableTrack("t1")], { startIndex: 0 });
      surface.dispatch(EventEnum.playing);
      expect(prefetchTrack).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("honors the data-saver preference", () => {
    const { surface, dispose } = mountEngine();
    const { prefetchTrack } = stubController();
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    try {
      usePlayerStore.getState().replaceQueue(
        [makePlayableTrack("t1"), makePlayableTrack("t2")],
        { startIndex: 0 },
      );
      surface.dispatch(EventEnum.playing);
      expect(prefetchTrack).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it("forwards explicit prefetch requests and swallows controller failures", () => {
    stubController({
      prefetchTrack: () => {
        throw new Error("controller exploded");
      },
    });
    const track = makePlayableTrack("t9");
    expect(() => usePlayerStore.getState().prefetchTrack(track)).not.toThrow();
  });

  it("is a no-op without a bound controller", () => {
    setPlaybackController(null);
    expect(() =>
      usePlayerStore.getState().prefetchTrack(makePlayableTrack("t9")),
    ).not.toThrow();
  });
});
