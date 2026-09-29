import { describe, expect, it, vi } from "vitest";
import { PlaybackResolutionError } from "@/lib/domain";
import { PlayerError } from "@/lib/player/engine";
import { createPlaybackController } from "@/lib/playback/controller";
import type { ControllerError } from "@/lib/playback/controller";
import {
  controllableResolver,
  fakeEngine,
  flush,
  manualClock,
  manualScheduler,
  sourceFor,
  spotifyTrack,
  youtubeTrack,
} from "./fake-controller-env";
import { STALL_THRESHOLD_MS } from "@/lib/playback/recovery";

function setup() {
  const engine = fakeEngine();
  const backend = controllableResolver();
  const errors: ControllerError[] = [];
  const controller = createPlaybackController({
    resolver: backend.resolver,
    engine,
    reportError: (error) => {
      errors.push(error);
    },
  });
  return { engine, backend, errors, controller };
}

describe("load semantics", () => {
  it("resolves and bridge-loads with autoplay intent", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ"));
    controller.loadTrack(youtubeTrack(), { autoplay: true });
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]).toMatchObject({ autoplay: true });
    expect(engine.loaded[0]?.track.streamUrl).toBe(
      "https://cdn.example/dQw4w9WgXcQ.m4a",
    );
    // Canonical track untouched: bridge copy carries the transient URL.
    expect(youtubeTrack().streamUrl).toBeUndefined();
  });

  it("loads without autoplay when requested", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ"));
    controller.loadTrack(youtubeTrack(), { autoplay: false });
    await flush();
    expect(engine.loaded[0]).toMatchObject({ autoplay: false });
  });

  it("reports resolution failure without touching the engine", async () => {
    const { engine, backend, errors, controller } = setup();
    backend.rejectNextWith(
      new PlaybackResolutionError(
        { provider: "youtube", providerTrackId: "dQw4w9WgXcQ" },
        "resolve",
        "Video unavailable",
      ),
    );
    controller.loadTrack(youtubeTrack());
    await flush();
    expect(engine.loaded).toHaveLength(0);
    expect(errors).toEqual([{ kind: "unavailable", message: "Video unavailable" }]);
  });

  it("reports unavailable for tracks without provider identity, without loading", async () => {
    const { engine, backend, errors, controller } = setup();
    const legacy = { ...spotifyTrack(), provider: "jamendo", providerTrackId: "j1" };
    controller.loadTrack(legacy);
    await flush();
    expect(backend.resolveSource).not.toHaveBeenCalled();
    expect(engine.loaded).toHaveLength(0);
    expect(errors).toEqual([
      { kind: "unavailable", message: "This track has no playable stream right now." },
    ]);
  });

  it("reports unavailable for tracks with empty provider ids, without loading", async () => {
    const { engine, backend, errors, controller } = setup();
    const bare = { ...youtubeTrack(), providerTrackId: "" };
    controller.loadTrack({ ...bare, streamUrl: undefined, previewUrl: undefined });
    await flush();
    expect(backend.resolveSource).not.toHaveBeenCalled();
    expect(engine.loaded).toHaveLength(0);
    expect(errors).toEqual([
      { kind: "unavailable", message: "This track has no playable stream right now." },
    ]);
  });

  it("never plays a previewUrl when no YouTube source exists", async () => {
    const { engine, errors, controller } = setup();
    // Spotify-only identity WITH a preview clip: resolution fails at the
    // match stage and the preview must not reach the engine.
    controller.loadTrack(spotifyTrack());
    await flush();
    expect(engine.loaded).toHaveLength(0);
    expect(errors).toEqual([
      { kind: "unavailable", message: "No playable source in this identity" },
    ]);
  });

  it("plays the resolved AudioSource, not the previewUrl, when YouTube is matched", async () => {
    const { engine, backend, controller } = setup();
    const track = {
      ...youtubeTrack(),
      previewUrl: "https://preview.example/decoy.mp3",
    };
    backend.resolveNextWith({
      url: "https://cdn.example/resolved.m4a",
      mimeType: "audio/mp4",
    });
    controller.loadTrack(track);
    await flush();
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.track.streamUrl).toBe("https://cdn.example/resolved.m4a");
    expect(engine.loaded[0]?.track.previewUrl).toBe("https://preview.example/decoy.mp3");
  });
});

describe("generation races", () => {
  it("discards a stale resolution that finishes after a newer load", async () => {
    const engine = fakeEngine();
    const errors: ControllerError[] = [];
    const releases: Array<(source: { url: string }) => void> = [];
    const { createPlaybackController } = await import(
      "@/lib/playback/controller"
    );
    const racing = createPlaybackController({
      resolver: {
        canResolve: () => true,
        resolve: vi.fn(
          () =>
            new Promise<{ url: string }>((resolve) => {
              releases.push(resolve);
            }),
        ),
      },
      engine,
      reportError: (error) => errors.push(error),
    });
    racing.loadTrack(youtubeTrack("dQw4w9WgXcQ"), { autoplay: true });
    racing.loadTrack(youtubeTrack("aaaaaaaaaaa"), { autoplay: true });
    expect(releases).toHaveLength(2);
    // Newer resolves first, then the stale one arrives late.
    releases[1]?.({ url: "https://cdn.example/current.m4a" });
    await flush();
    releases[0]?.({ url: "https://cdn.example/stale.m4a" });
    await flush();
    await flush();
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.track.streamUrl).toBe(
      "https://cdn.example/current.m4a",
    );
    expect(errors).toEqual([]);
  });

  it("pause during resolution defeats pending autoplay", async () => {
    const { engine, backend, controller } = setup();
    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    backend.resolveSource.mockImplementationOnce(() => gate);
    controller.loadTrack(youtubeTrack(), { autoplay: true });
    controller.pause();
    release({ url: "https://cdn.example/a.m4a" });
    await flush();
    await flush();
    expect(engine.pauseCalls).toBe(1);
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]).toMatchObject({ autoplay: false });
  });

  it("stop during resolution prevents any load", async () => {
    const { engine, backend, controller } = setup();
    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    backend.resolveSource.mockImplementationOnce(() => gate);
    controller.loadTrack(youtubeTrack(), { autoplay: true });
    controller.stop();
    release({ url: "https://cdn.example/a.m4a" });
    await flush();
    await flush();
    expect(engine.loaded).toHaveLength(0);
  });

  it("shutdown invalidates pending resolutions and detaches", async () => {
    const { engine, backend, errors, controller } = setup();
    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    backend.resolveSource.mockImplementationOnce(() => gate);
    controller.loadTrack(youtubeTrack());
    controller.shutdown();
    release({ url: "https://cdn.example/a.m4a" });
    await flush();
    await flush();
    expect(engine.loaded).toHaveLength(0);
    expect(errors).toEqual([]);
    engine.emitError();
  });
});

describe("resolution deduplication and source reuse", () => {
  it("coalesces duplicate concurrent loads of the same track into one resolution", async () => {
    const { engine, backend, controller } = setup();
    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    backend.resolveSource.mockImplementationOnce(() => gate);

    // Two synchronous loads of the same identity, as a double click or a
    // double-fired effect would produce.
    controller.loadTrack(youtubeTrack(), { autoplay: true });
    controller.loadTrack(youtubeTrack(), { autoplay: true });
    release({ url: "https://cdn.example/one.m4a" });
    await flush();
    await flush();

    // One upstream call, one load: the shared result applies to the newest
    // generation, the superseded one is discarded.
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.track.streamUrl).toBe("https://cdn.example/one.m4a");
  });

  it("re-resolves genuinely different tracks independently", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("a"));
    controller.loadTrack(youtubeTrack("dQw4w9WgXcQ"));
    backend.resolveNextWith(sourceFor("b"));
    controller.loadTrack(youtubeTrack("aaaaaaaaaaa"));
    await flush();
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]?.track.streamUrl).toBe("https://cdn.example/b.m4a");
  });

  it("reuses the live source when the same track is loaded again", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ"));
    controller.loadTrack(youtubeTrack());
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);
    expect(engine.loaded).toHaveLength(1);

    // Re-click the same track: source is fresh, so no second resolution.
    controller.loadTrack(youtubeTrack(), { autoplay: true });
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);
    expect(engine.loaded).toHaveLength(2);
    expect(engine.loaded[1]?.track.streamUrl).toBe(
      "https://cdn.example/dQw4w9WgXcQ.m4a",
    );
  });

  it("re-resolves when the active source has expired", async () => {
    const engine = fakeEngine();
    const backend = controllableResolver();
    let nowMs = 1_000_000;
    const controller = createPlaybackController({
      resolver: backend.resolver,
      engine,
      reportError: () => undefined,
      now: () => nowMs,
    });
    backend.resolveNextWith({
      ...sourceFor("dQw4w9WgXcQ"),
      expiresAt: new Date(nowMs + 60_000),
    });
    controller.loadTrack(youtubeTrack());
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(1);

    nowMs += 120_000; // past the source's expiry
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ", "https://cdn.example/fresh.m4a"));
    controller.loadTrack(youtubeTrack());
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    expect(engine.loaded[1]?.track.streamUrl).toBe("https://cdn.example/fresh.m4a");
  });
});

describe("transport coordination", () => {
  it("plays the loaded source directly when fresh", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ"));
    controller.loadTrack(youtubeTrack());
    await flush();
    await controller.ensurePlaying();
    expect(engine.playCalls).toBe(1);
  });

  it("re-resolves on resume after a failed load", async () => {
    const { engine, backend, controller } = setup();
    backend.rejectNextWith(
      new PlaybackResolutionError(
        { provider: "youtube", providerTrackId: "dQw4w9WgXcQ" },
        "resolve",
        "Video unavailable",
      ),
    );
    controller.loadTrack(youtubeTrack());
    await flush();
    expect(engine.loaded).toHaveLength(0);
    // Resume re-resolves the same stable identity with autoplay.
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ", "https://cdn.example/fresh.m4a"));
    await controller.ensurePlaying();
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    expect(engine.loaded).toHaveLength(1);
    expect(engine.loaded[0]).toMatchObject({
      autoplay: true,
      track: expect.objectContaining({ streamUrl: "https://cdn.example/fresh.m4a" }),
    });
  });

  it("rejects expired sources instead of loading them", async () => {
    const { engine, backend, errors, controller } = setup();
    backend.resolveNextWith({
      ...sourceFor("dQw4w9WgXcQ"),
      expiresAt: new Date(Date.now() - 1000),
    });
    controller.loadTrack(youtubeTrack());
    await flush();
    expect(engine.loaded).toHaveLength(0);
    expect(errors).toEqual([
      { kind: "unavailable", message: "This track has no playable stream right now." },
    ]);
  });

  it("maps engine play failures to playback errors", async () => {
    const { engine, backend, errors, controller } = setup();
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ"));
    controller.loadTrack(youtubeTrack());
    await flush();
    engine.failPlayWith = new PlayerError("playback", "Playback failed unexpectedly.");
    await controller.ensurePlaying();
    expect(errors).toEqual([
      { kind: "playback", message: "Playback failed unexpectedly." },
    ]);
  });

  it("remembers seek requests across pending resolution", async () => {
    const { engine, backend, controller } = setup();
    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    backend.resolveSource.mockImplementationOnce(() => gate);
    controller.loadTrack(youtubeTrack());
    controller.notifySeekRequest(42);
    release({ url: "https://cdn.example/a.m4a" });
    await flush();
    await flush();
    expect(engine.loaded).toHaveLength(1);
    expect(engine.seeks).toEqual([42]);
  });

  it("drops seeks from superseded generations", async () => {
    const { engine, backend, controller } = setup();
    backend.resolveNextWith(sourceFor("a"));
    controller.loadTrack(youtubeTrack("dQw4w9WgXcQ"));
    controller.notifySeekRequest(42);
    backend.resolveNextWith(sourceFor("b"));
    controller.loadTrack(youtubeTrack("dQw4w9WgXcQ"));
    await flush();
    await flush();
    expect(engine.seeks).toEqual([]);
  });
});

describe("mid-playback recovery", () => {
  it("bounds recovery to two attempts, then reports final failure", async () => {
    const engine = fakeEngine();
    const backend = controllableResolver();
    const errors: ControllerError[] = [];
    const clock = manualClock();
    const timers = manualScheduler();
    const controller = createPlaybackController({
      resolver: backend.resolver,
      engine,
      reportError: (error) => {
        errors.push(error);
      },
      now: clock.now,
      schedule: timers.schedule,
    });
    const runRecoveryTimers = () => {
      for (const entry of timers.pending.filter(
        (item) => !item.cancelled && item.delayMs < STALL_THRESHOLD_MS,
      )) {
        entry.cancelled = true;
        entry.callback();
      }
    };
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ", "https://cdn.example/a.m4a"));
    controller.loadTrack(youtubeTrack());
    await flush();
    engine.emit("playing");

    // Failure 1 → attempt 1 → fresh resolve + reload.
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    engine.emitError();
    expect(controller.isRecovering()).toBe(true);
    runRecoveryTimers();
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(2);
    expect(engine.loaded).toHaveLength(2);

    // Failure 2 → attempt 2 → fresh resolve + reload.
    backend.resolveNextWith(sourceFor("dQw4w9WgXcQ", "https://cdn.example/c.m4a"));
    engine.emitError();
    runRecoveryTimers();
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(3);
    expect(engine.loaded).toHaveLength(3);

    // Failure 3 → budget exhausted → final error, no further attempts,
    // and repeats for the same dead source stay suppressed.
    engine.emitError();
    await flush();
    engine.emitError();
    await flush();
    runRecoveryTimers();
    await flush();
    expect(backend.resolveSource).toHaveBeenCalledTimes(3);
    expect(engine.loaded).toHaveLength(3);
    expect(errors).toEqual([
      { kind: "playback", message: "Playback failed unexpectedly." },
    ]);
    expect(controller.isRecovering()).toBe(false);
  });
});
