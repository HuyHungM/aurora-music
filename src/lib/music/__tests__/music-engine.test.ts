import { describe, expect, it, vi } from "vitest";
import { NormalizationError } from "@/lib/domain";
import { createMusicEngine } from "@/lib/music/music-engine";
import type { MusicEngineDeps, TrackLookupPort } from "@/lib/music/music-engine";
import { createQueueManager } from "@/lib/music/queue-manager";
import {
  fakeEnv,
  fakeSignals,
  identity,
  searchResult,
  track,
} from "./fake-facade-env";

function setup(overrides: Partial<MusicEngineDeps> = {}) {
  const env = fakeEnv();
  const getState = () => env.state;
  const manager = createQueueManager({ getState, actions: env.actions });
  const signals = fakeSignals();
  const searchFn = vi.fn(async () => searchResult());
  const getTrack = vi.fn<TrackLookupPort["getTrack"]>(async () => null);
  const storeListeners = new Set<() => void>();
  const engine = createMusicEngine({
    getState,
    actions: env.actions,
    engine: signals,
    search: { search: searchFn },
    lookup: { getTrack },
    queue: manager,
    subscribeStore: (listener: () => void) => {
      storeListeners.add(listener);
      return () => {
        storeListeners.delete(listener);
      };
    },
    ...overrides,
  });
  engine.initialize();
  const notifyStore = () => {
    for (const listener of [...storeListeners]) {
      listener();
    }
  };
  return { state: env.state, actions: env.actions, signals, searchFn, getTrack, engine, notifyStore };
}

describe("commands", () => {
  it("plays identities, tracks, refs, urls, and queries", async () => {
    const { actions, searchFn, getTrack, engine } = setup();
    await engine.play(identity());
    expect(actions.calls[0]).toMatchObject({ action: "replaceQueue" });

    await engine.play(track());
    expect(actions.calls[1]?.action).toBe("replaceQueue");

    getTrack.mockResolvedValueOnce(track("spotify", "sp-1"));
    await engine.play({ provider: "spotify", providerTrackId: "sp-1" });
    expect(getTrack).toHaveBeenCalledWith({ provider: "spotify", id: "sp-1" });

    getTrack.mockResolvedValueOnce(track("youtube", "yt-9"));
    await engine.play("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(getTrack).toHaveBeenCalledWith({ provider: "youtube", id: "dQw4w9WgXcQ" });

    searchFn.mockResolvedValueOnce(searchResult([identity()]));
    await engine.play("Lạc Trôi");
    expect(searchFn).toHaveBeenCalledWith("Lạc Trôi");
    expect(actions.calls.filter((call) => call.action === "replaceQueue")).toHaveLength(5);
  });

  it("respects autoplay options", async () => {
    const { actions, engine } = setup();
    await engine.play(identity(), { autoplay: false });
    expect(actions.calls[0]).toEqual({
      action: "replaceQueue",
      args: [expect.anything(), { startIndex: 0, autoplay: false }],
    });
  });

  it("rejects invalid inputs without touching the store", async () => {
    const { actions, engine } = setup();
    await expect(engine.play("   ")).rejects.toBeInstanceOf(NormalizationError);
    await expect(engine.play(42 as never)).rejects.toBeInstanceOf(NormalizationError);
    await expect(
      engine.play({ provider: "spotify", providerTrackId: "missing" }),
    ).rejects.toMatchObject({ name: "TrackNotFoundError" });
    expect(actions.calls).toHaveLength(0);
  });

  it("rejects empty search results", async () => {
    const { engine } = setup();
    await expect(engine.play("zzz-no-match-ever")).rejects.toBeInstanceOf(
      NormalizationError,
    );
  });

  it("delegates pause/resume/stop/seek/volume", async () => {
    const { actions, engine } = setup();
    engine.pause();
    await engine.resume();
    engine.seek(30);
    engine.setVolume(0.5);
    expect(actions.calls.map((call) => call.action)).toEqual([
      "pause",
      "play",
      "seek",
      "setVolume",
    ]);
  });

  it("validates seek and volume", () => {
    const { engine } = setup();
    expect(() => engine.seek(-1)).toThrow(NormalizationError);
    expect(() => engine.seek(Number.NaN)).toThrow(NormalizationError);
    expect(() => engine.setVolume(Number.NaN)).toThrow(NormalizationError);
  });

  it("maps setRepeat onto the canonical repeat modes", () => {
    const { state, engine } = setup();
    engine.setRepeat("track");
    expect(state.repeat).toBe("one");
    engine.setRepeat("queue");
    expect(state.repeat).toBe("all");
    engine.setRepeat("off");
    expect(state.repeat).toBe("off");
    expect(() => engine.setRepeat("everything" as never)).toThrow(NormalizationError);
  });

  it("toggles or sets shuffle", () => {
    const { state, engine } = setup();
    engine.shuffle();
    expect(state.shuffle).toBe(true);
    engine.shuffle(false);
    expect(state.shuffle).toBe(false);
    engine.shuffle(false);
    expect(state.shuffle).toBe(false);
  });
});

describe("queue facade", () => {
  it("adds identities and tracks, removes, moves, and clears", () => {
    const { state, actions, engine } = setup();
    engine.queue.add(identity());
    engine.queue.add(track());
    engine.queue.add(track("youtube", "yt-3"));
    expect(actions.calls.map((call) => call.action)).toEqual([
      "addToQueue",
      "addToQueue",
      "addToQueue",
    ]);
    expect(state.queue).toHaveLength(3);

    engine.queue.remove(0);
    expect(state.queue).toHaveLength(2);
    engine.queue.move(0, 1);
    expect(actions.calls.map((call) => call.action)).toContain("removeFromQueue");
    expect(actions.calls.map((call) => call.action)).toContain("moveQueueItem");
    engine.queue.clear();
    expect(state.queue).toHaveLength(0);
    expect(engine.queue.length).toBe(0);
  });

  it("validates queue indices", () => {
    const { engine } = setup();
    expect(() => engine.queue.remove(-1)).toThrow(NormalizationError);
    expect(() => engine.queue.remove(0)).toThrow(NormalizationError);
    expect(() => engine.queue.move(0, 5)).toThrow(NormalizationError);
  });

  it("exposes read-only snapshots", () => {
    const { state, engine } = setup();
    state.queue = [track("youtube", "yt-1")];
    state.playOrder = [0];
    expect(engine.queue.items).toHaveLength(1);
    expect(engine.queue.currentIndex).toBe(state.position);
  });
});

describe("search facade", () => {
  it("delegates to UnifiedSearch with validation", async () => {
    const { searchFn, engine } = setup();
    searchFn.mockResolvedValueOnce(searchResult([identity()]));
    const result = await engine.search("Lạc Trôi");
    expect(searchFn).toHaveBeenCalledWith("Lạc Trôi", undefined);
    expect(result.tracks).toHaveLength(1);
    await expect(engine.search("  ")).rejects.toBeInstanceOf(NormalizationError);
  });
});

describe("state snapshot", () => {
  it("derives read-only state without leaking mutable references", () => {
    const { state, engine } = setup();
    state.currentTrack = track("youtube", "yt-1");
    state.queue = [state.currentTrack];
    state.playOrder = [0];
    state.position = 0;
    state.isPlaying = true;
    state.repeat = "one";
    state.error = { kind: "playback", message: "boom" };

    const first = engine.getState();
    expect(first.currentTrack?.primarySource).toMatchObject({ source: "youtube", id: "yt-1" });
    expect(first.queue).toHaveLength(1);
    expect(first.currentIndex).toBe(0);
    expect(first.isPlaying).toBe(true);
    expect(first.repeat).toBe("track");
    expect(first.isResolving).toBe(false);
    expect(first.error).toMatchObject({ name: "PlayerError", message: "boom" });

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.queue)).toBe(true);
    expect(engine.getState().queue).toHaveLength(1);
    // Unchanged store content yields reference-stable snapshots.
    expect(engine.getState().queue).toBe(first.queue);
    expect(engine.getState().currentTrack).toBe(first.currentTrack);
    // Serialized errors are memoized while the store error is unchanged so
    // useSyncExternalStore consumers never see a fresh literal per read.
    expect(engine.getState().error).toBe(first.error);
    expect(Object.isFrozen(first.error)).toBe(true);
    state.error = { kind: "playback", message: "changed" };
    expect(engine.getState().error).toMatchObject({ message: "changed" });
    expect(engine.getState().error).not.toBe(first.error);
    state.error = null;
    expect(engine.getState().error).toBeNull();
  });

  it("reads fresh state after mutations, never a stale snapshot", () => {
    const { state, engine } = setup();
    expect(engine.getState().queue).toHaveLength(0);
    state.queue = [track("youtube", "yt-1")];
    state.playOrder = [0];
    state.position = 0;
    state.currentTrack = state.queue[0] ?? null;
    const snapshot = engine.getState();
    expect(snapshot.queue).toHaveLength(1);
    expect(snapshot.currentTrack?.primarySource).toMatchObject({ id: "yt-1" });
  });

  it("re-initializes after shutdown without duplicate subscriptions", () => {
    const { engine, notifyStore } = setup();
    let emissions = 0;
    const off = engine.subscribe(() => {
      emissions += 1;
    });
    notifyStore();
    expect(emissions).toBe(1);
    engine.shutdown();
    notifyStore();
    expect(emissions).toBe(1);
    engine.initialize();
    notifyStore();
    // Exactly one emission: the shutdown detached the old subscription
    // instead of stacking a second one alongside the new.
    expect(emissions).toBe(2);
    off();
  });
});
