import { describe, expect, it, vi } from "vitest";
import { createMusicEngine } from "@/lib/music/music-engine";
import type { MusicEngineDeps } from "@/lib/music/music-engine";
import type { MusicEngineEvents } from "@/lib/music/events";
import { createQueueManager } from "@/lib/music/queue-manager";
import type { EngineStoreState } from "@/lib/music/music-engine";
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
  const engine = createMusicEngine({
    getState,
    actions: env.actions,
    engine: signals,
    search: { search: vi.fn(async () => searchResult()) },
    lookup: { getTrack: vi.fn(async () => null) },
    queue: manager,
    subscribeStore: () => () => undefined,
    ...overrides,
  });
  engine.initialize();
  return { state: env.state, actions: env.actions, signals, engine };
}

function withCurrentTrack(state: EngineStoreState, id = "yt-1") {
  state.currentTrack = track("youtube", id);
  state.queue = [state.currentTrack];
  state.playOrder = [0];
  state.position = 0;
}

describe("trackStart", () => {
  it("fires once per actual start, keyed by source", () => {
    const { state, signals, engine } = setup();
    const starts: Array<MusicEngineEvents["trackStart"]> = [];
    engine.on("trackStart", (payload) => {
      starts.push(payload);
    });
    withCurrentTrack(state);

    signals.emitPlaying();
    signals.emitPlaying();
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ index: 0 });
    expect(starts[0]?.track.primarySource).toMatchObject({ source: "youtube", id: "yt-1" });
  });

  it("fires again after a track change", () => {
    const { state, signals, engine } = setup();
    const starts: string[] = [];
    engine.on("trackStart", (payload) => {
      starts.push(payload.track.primarySource.id);
    });
    withCurrentTrack(state, "yt-1");
    signals.emitPlaying();
    withCurrentTrack(state, "yt-2");
    signals.emitPlaying();
    expect(starts).toEqual(["yt-1", "yt-2"]);
  });
});

describe("trackEnd ordering", () => {
  it("emits trackEnd(natural) then trackStart on transition", () => {
    const { state, signals, engine } = setup();
    const order: string[] = [];
    engine.on("trackEnd", (payload) => {
      order.push(`end:${payload.track.primarySource.id}:${payload.reason}`);
    });
    engine.on("trackStart", (payload) => {
      order.push(`start:${payload.track.primarySource.id}`);
    });
    withCurrentTrack(state, "yt-1");
    signals.emitPlaying();
    // Store advances the queue first (its own ended handler ran earlier
    // in production listener order); simulate the post-advance state.
    withCurrentTrack(state, "yt-2");
    signals.emitEnded();
    signals.emitPlaying();
    expect(order).toEqual(["start:yt-1", "end:yt-1:natural", "start:yt-2"]);
  });

  it("emits trackEnd(last) then queueEnd on exhaustion", () => {
    const { state, signals, engine } = setup();
    const order: string[] = [];
    engine.on("trackEnd", (payload) => {
      order.push(`end:${payload.reason}`);
    });
    engine.on("queueEnd", (payload) => {
      order.push(`queueEnd:${payload.queue.length}`);
    });
    withCurrentTrack(state, "yt-1");
    signals.emitPlaying();
    state.isPlaying = false;
    state.isLoading = false;
    signals.emitEnded();
    expect(order).toEqual(["end:natural", "queueEnd:1"]);
  });

  it("skips queueEnd while a transition is loading", () => {
    const { state, signals, engine } = setup();
    const queueEnds: unknown[] = [];
    engine.on("queueEnd", (payload) => {
      queueEnds.push(payload);
    });
    withCurrentTrack(state, "yt-1");
    signals.emitPlaying();
    withCurrentTrack(state, "yt-2");
    state.isLoading = true;
    signals.emitEnded();
    expect(queueEnds).toHaveLength(0);
  });

  it("emits skip and stop reasons from commands", () => {
    const { state, actions, engine } = setup();
    const ends: Array<MusicEngineEvents["trackEnd"]> = [];
    engine.on("trackEnd", (payload) => {
      ends.push(payload);
    });
    withCurrentTrack(state, "yt-1");
    engine.skip();
    engine.previous();
    engine.stop();
    expect(ends.map((entry) => entry.reason)).toEqual(["skip", "skip", "stop"]);
    expect(actions.calls.map((call) => call.action)).toEqual([
      "next",
      "prev",
      "clearQueue",
    ]);
  });
});

describe("trackError", () => {
  function setupWithStoreNotifications() {
    const listeners = new Set<() => void>();
    const inner = setup({
      subscribeStore: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    return {
      ...inner,
      notifyStore: () => {
        for (const listener of [...listeners]) {
          listener();
        }
      },
    };
  }

  async function flushMicrotasks(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("emits trackError for surviving store errors with the current track", async () => {
    const { state, engine, notifyStore } = setupWithStoreNotifications();
    const errors: Array<MusicEngineEvents["trackError"]> = [];
    engine.on("trackError", (payload) => {
      errors.push(payload);
    });
    withCurrentTrack(state, "yt-1");
    state.error = { kind: "playback", message: "boom" };
    notifyStore();
    await flushMicrotasks();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.track?.primarySource).toMatchObject({ source: "youtube", id: "yt-1" });
    expect(errors[0]?.error).toMatchObject({
      code: "ENGINE_ERROR",
      message: "boom",
    });
  });

  it("does not emit for transient errors cleared by recovery first", async () => {
    const { state, engine, notifyStore } = setupWithStoreNotifications();
    const errors: Array<MusicEngineEvents["trackError"]> = [];
    engine.on("trackError", (payload) => {
      errors.push(payload);
    });
    withCurrentTrack(state, "yt-1");
    // Same task: error surfaces, then a recovery cycle clears it.
    state.error = { kind: "playback", message: "boom" };
    notifyStore();
    state.error = null;
    notifyStore();
    await flushMicrotasks();
    expect(errors).toHaveLength(0);
  });

  it("never emits a pending error after shutdown", async () => {
    const { state, engine, notifyStore } = setupWithStoreNotifications();
    const errors: Array<MusicEngineEvents["trackError"]> = [];
    engine.on("trackError", (payload) => {
      errors.push(payload);
    });
    withCurrentTrack(state, "yt-1");
    state.error = { kind: "playback", message: "boom" };
    notifyStore();
    engine.shutdown();
    await flushMicrotasks();
    expect(errors).toHaveLength(0);
  });

  it("emits trackError from resolution failures", () => {
    const { state, engine } = setup();
    const errors: Array<MusicEngineEvents["trackError"]> = [];
    engine.on("trackError", (payload) => {
      errors.push(payload);
    });
    withCurrentTrack(state, "yt-1");
    engine.notifyResolutionError({
      name: "PlaybackResolutionError",
      code: "PLAYBACK_RESOLUTION_ERROR",
      message: "Video unavailable",
      retryable: false,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.message).toBe("Video unavailable");
  });
});

describe("lifecycle", () => {
  it("initialize is idempotent and shutdown detaches", () => {
    const { signals, engine } = setup();
    engine.initialize();
    engine.initialize();
    expect(signals.listenerCount()).toBe(2);
    engine.shutdown();
    expect(signals.listenerCount()).toBe(0);
    engine.shutdown();
    expect(signals.listenerCount()).toBe(0);
  });

  it("ignores engine signals after shutdown and remounts cleanly", () => {
    const { state, signals, engine } = setup();
    const starts: unknown[] = [];
    engine.on("trackStart", (payload) => {
      starts.push(payload);
    });
    engine.shutdown();
    withCurrentTrack(state, "yt-1");
    signals.emitPlaying();
    expect(starts).toHaveLength(0);

    engine.initialize();
    signals.emitPlaying();
    expect(starts).toHaveLength(1);
  });

  it("stale commands after shutdown throw instead of acting", async () => {
    const { actions, engine } = setup();
    engine.shutdown();
    await expect(engine.play(identity())).rejects.toThrow("shut down");
    expect(actions.calls).toHaveLength(0);
  });
});

describe("races", () => {
  it("play A then play B delegates both in order without phantom events", async () => {
    const { state, actions, signals, engine } = setup();
    const starts: string[] = [];
    engine.on("trackStart", (payload) => {
      starts.push(payload.track.primarySource.id);
    });
    await engine.play(identity("youtube", "yt-a"));
    await engine.play(identity("youtube", "yt-b"));
    expect(
      actions.calls.filter((call) => call.action === "replaceQueue"),
    ).toHaveLength(2);
    // No engine signals yet: no misleading trackStart for either.
    expect(starts).toHaveLength(0);
    withCurrentTrack(state, "yt-b");
    state.isPlaying = true;
    signals.emitPlaying();
    expect(starts).toEqual(["yt-b"]);
  });

  it("stop during pending play prevents late trackStart for the old track", async () => {
    const { actions, signals, engine } = setup();
    const starts: string[] = [];
    engine.on("trackStart", (payload) => {
      starts.push(payload.track.primarySource.id);
    });
    await engine.play(identity("youtube", "yt-a"));
    engine.stop();
    // Queue cleared: currentTrack is null, so a stray playing signal
    // cannot attribute a start.
    signals.emitPlaying();
    expect(starts).toHaveLength(0);
    expect(actions.calls.map((call) => call.action)).toContain("clearQueue");
  });
});
