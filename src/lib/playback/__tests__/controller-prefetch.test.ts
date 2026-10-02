import { describe, expect, it } from "vitest";
import type { AudioSource } from "@/lib/domain";
import { PlayerError } from "@/lib/player/engine";
import { createPlaybackController } from "@/lib/playback/controller";
import type { ControllerError } from "@/lib/playback/controller";
import type { Track } from "@/lib/domain";
import {
  controllableResolver,
  fakeEngine,
  flush,
  manualClock,
  manualScheduler,
  sourceFor,
  youtubeTrack,
} from "./fake-controller-env";

function track(id: string): Track {
  return { ...youtubeTrack(), id, providerTrackId: id };
}

function setup() {
  const engine = fakeEngine();
  const backend = controllableResolver();
  const errors: ControllerError[] = [];
  const deadSources: Array<{ source: string; id: string }> = [];
  const controller = createPlaybackController({
    resolver: backend.resolver,
    engine,
    reportError: (error) => {
      errors.push(error);
    },
    reportDeadSource: (ref) => {
      deadSources.push(ref);
    },
  });
  return { engine, backend, errors, deadSources, controller };
}

describe("prefetch", () => {
  it("warms the next track so its load spends no resolution", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("next-track-1"));
    controller.prefetchTrack(track("next-track-1"));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);

    // The load consumes the slot: no second resolution, engine loads at once.
    controller.loadTrack(track("next-track-1"));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.track.streamUrl).toBe(
      "https://cdn.example/next-track-1.m4a",
    );
  });

  it("shares one upstream promise when prefetch races the real load", async () => {
    const { engine, backend, controller } = setup();
    let release!: (source: AudioSource) => void;
    const gate = new Promise<AudioSource>((resolve) => {
      release = resolve;
    });
    backend.resolveSource.mockImplementationOnce(() => gate);
    controller.prefetchTrack(track("race-track-1"));
    controller.loadTrack(track("race-track-1"));
    await flush();
    // Both paths awaited the same in-flight resolution.
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);
    expect(engine.loaded).toHaveLength(0);
    release(sourceFor("race-track-1"));
    await flush();
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.track.streamUrl).toBe(
      "https://cdn.example/race-track-1.m4a",
    );
  });

  it("never reports a prefetch failure and never poisons the slot", async () => {
    const { engine, backend, errors, controller } = setup();
    backend.rejectNextWith(new Error("fetch failed"));
    controller.prefetchTrack(track("doomed-track"));
    await flush();
    expect(errors).toEqual([]);
    expect(engine.loaded).toHaveLength(0);

    // The real load afterwards resolves normally: the failed prefetch left
    // nothing behind that could be mistaken for an answer.
    backend.resolveNextWith(sourceFor("doomed-track"));
    controller.loadTrack(track("doomed-track"));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    expect(engine.loaded).toHaveLength(1);
  });

  it("refuses an expired prefetched source and re-resolves", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith({
      ...sourceFor("stale-track-1"),
      expiresAt: new Date(Date.now() - 1_000),
    });
    controller.prefetchTrack(track("stale-track-1"));
    await flush();
    // Dead on arrival: never even occupies the slot.
    backend.resolveNextWith(sourceFor("stale-track-1"));
    controller.loadTrack(track("stale-track-1"));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    expect(engine.loaded).toHaveLength(1);
  });

  it("does not apply a prefetched source to a different track", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("track-aaaa-1"));
    controller.prefetchTrack(track("track-aaaa-1"));
    await flush();

    backend.resolveNextWith(sourceFor("track-bbbb-2"));
    controller.loadTrack(track("track-bbbb-2"));
    await flush();
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.track.streamUrl).toBe(
      "https://cdn.example/track-bbbb-2.m4a",
    );
    // The slot for A survives for a later load that actually matches.
    controller.loadTrack(track("track-aaaa-1"));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    expect(engine.loaded).toHaveLength(2);
    expect(engine.loaded[1]?.track.streamUrl).toBe(
      "https://cdn.example/track-aaaa-1.m4a",
    );
  });

  it("skips prefetching the track that already owns a live source", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("live-track-1"));
    controller.loadTrack(track("live-track-1"));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);

    controller.prefetchTrack(track("live-track-1"));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);
    expect(engine.loaded).toHaveLength(1);
  });

  it("drops the slot on stop and shutdown", async () => {
    const { backend, controller } = setup();
    backend.resolveNextWith(sourceFor("gone-track-1"));
    controller.prefetchTrack(track("gone-track-1"));
    await flush();
    controller.stop();

    backend.resolveNextWith(sourceFor("gone-track-1"));
    controller.loadTrack(track("gone-track-1"));
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    controller.shutdown();
  });
});

describe("dead-source reporting", () => {
  function setupRecovery() {
    const engine = fakeEngine();
    const backend = controllableResolver();
    const errors: ControllerError[] = [];
    const deadSources: Array<{ source: string; id: string }> = [];
    const clock = manualClock(Date.now());
    const timers = manualScheduler();
    const controller = createPlaybackController({
      resolver: backend.resolver,
      engine,
      reportError: (error) => {
        errors.push(error);
      },
      reportDeadSource: (ref) => {
        deadSources.push(ref);
      },
      now: clock.now,
      schedule: timers.schedule,
    });
    return { engine, backend, errors, deadSources, timers, controller };
  }

  function runRecoveryTimers(env: ReturnType<typeof setupRecovery>): void {
    for (const entry of env.timers.pending.filter((item) => !item.cancelled)) {
      entry.cancelled = true;
      entry.callback();
    }
  }

  it("reports the youtube id once a cycle exhausts on a dead URL", async () => {
    const env = setupRecovery();
    env.backend.resolveNextWith(sourceFor("dQw4w9WgXcQ", "https://cdn.example/a.m4a"));
    env.controller.loadTrack(youtubeTrack());
    await flush();
    env.engine.emit("playing");

    // Persistent media failure through the whole budget.
    env.backend.rejectNextWith(new Error("fetch failed"));
    env.engine.emitError({ error: new PlayerError("playback", "boom", 2) });
    runRecoveryTimers(env);
    await flush();
    env.backend.rejectNextWith(new Error("fetch failed"));
    runRecoveryTimers(env);
    await flush();

    expect(env.deadSources).toEqual([{ source: "youtube", id: "dQw4w9WgXcQ" }]);
  });

  it("never reports when recovery succeeds", async () => {
    const env = setupRecovery();
    env.backend.resolveNextWith(sourceFor("dQw4w9WgXcQ", "https://cdn.example/a.m4a"));
    env.controller.loadTrack(youtubeTrack());
    await flush();
    env.engine.emit("playing");

    env.backend.resolveNextWith(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError({ error: new PlayerError("playback", "boom", 2) });
    runRecoveryTimers(env);
    await flush();
    env.engine.emit("playing");
    await flush();

    expect(env.deadSources).toEqual([]);
  });
});
