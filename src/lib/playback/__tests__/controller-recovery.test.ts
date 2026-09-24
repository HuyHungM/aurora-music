import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractorError, PlaybackResolutionError } from "@/lib/domain";
import { PlayerError } from "@/lib/player/engine";
import { createPlaybackController } from "@/lib/playback/controller";
import type { ControllerError } from "@/lib/playback/controller";
import { STALL_THRESHOLD_MS } from "@/lib/playback/recovery";
import { setLogLevel, setLogSink } from "@/lib/diagnostics/logger";
import type { LogRecord } from "@/lib/diagnostics/logger";
import {
  controllableResolver,
  fakeEngine,
  flush,
  manualClock,
  manualScheduler,
  sourceFor,
  youtubeTrack,
} from "./fake-controller-env";
import type { ManualClock, ManualScheduler } from "./fake-controller-env";
import type { FakeEngine } from "./fake-controller-env";

interface RecoveryEnv {
  engine: FakeEngine;
  resolveSource: ReturnType<typeof controllableResolver>["resolveSource"];
  stubResolve: (source: Parameters<ReturnType<typeof controllableResolver>["resolveNextWith"]>[0]) => void;
  stubReject: (error: unknown) => void;
  errors: ControllerError[];
  cleared: { count: number };
  clock: ManualClock;
  timers: ManualScheduler;
  controller: ReturnType<typeof createPlaybackController>;
}

/** Manual clock starts at wall-clock time so expiry checks stay realistic. */
function setupRecovery(): RecoveryEnv {
  const engine = fakeEngine();
  const backend = controllableResolver();
  const errors: ControllerError[] = [];
  const cleared = { count: 0 };
  const clock = manualClock(Date.now());
  const timers = manualScheduler();
  const controller = createPlaybackController({
    resolver: backend.resolver,
    engine,
    reportError: (error) => {
      errors.push(error);
    },
    now: clock.now,
    schedule: timers.schedule,
    clearError: () => {
      cleared.count += 1;
    },
  });
  return {
    engine,
    resolveSource: backend.resolveSource,
    stubResolve: (source) => backend.resolveNextWith(source),
    stubReject: (error) => backend.rejectNextWith(error),
    errors,
    cleared,
    clock,
    timers,
    controller,
  };
}

/** Run pending recovery-round timers (delays are always < STALL_THRESHOLD). */
function runRecoveryTimers(env: RecoveryEnv): void {
  for (const entry of env.timers.pending.filter(
    (item) => !item.cancelled && item.delayMs < STALL_THRESHOLD_MS,
  )) {
    entry.cancelled = true;
    entry.callback();
  }
}

/** Run each currently-pending timer exactly once (newly scheduled ones wait). */
function drainOnce(env: RecoveryEnv): void {
  const due = env.timers.pending.filter((item) => !item.cancelled);
  for (const entry of due) {
    entry.cancelled = true;
    entry.callback();
  }
}

function pendingRecoveryTimers(env: RecoveryEnv): number {
  return env.timers.pending.filter(
    (item) => !item.cancelled && item.delayMs < STALL_THRESHOLD_MS,
  ).length;
}

/** Load a track and drive it to steady playing state. */
async function loadPlaying(
  env: RecoveryEnv,
  url = "https://cdn.example/a.m4a",
): Promise<void> {
  env.stubResolve(sourceFor("dQw4w9WgXcQ", url));
  env.controller.loadTrack(youtubeTrack());
  await flush();
  env.engine.emit("playing");
}

let restoreSink: (() => void) | null = null;

beforeEach(() => {
  vi.useRealTimers();
  // Quiet suites by default; tests asserting diagnostics install their own
  // capture sink and level explicitly.
  setLogLevel("debug");
  restoreSink = setLogSink(() => undefined);
});

afterEach(() => {
  restoreSink?.();
  restoreSink = null;
  setLogLevel("error");
});

describe("error recovery", () => {
  it("re-resolves the same identity and reloads with autoplay on first error", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.engine.position = 100;

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError({ error: new PlayerError("playback", "boom", 2) });

    expect(env.controller.isRecovering()).toBe(true);
    expect(env.cleared.count).toBe(1);
    runRecoveryTimers(env);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(2);
    expect(env.resolveSource).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "youtube", id: "dQw4w9WgXcQ" }),
    );
    expect(env.engine.loaded).toHaveLength(2);
    expect(env.engine.loaded[1]).toMatchObject({ autoplay: true });
    expect(env.engine.loaded[1]?.track.streamUrl).toBe(
      "https://cdn.example/b.m4a",
    );
    expect(env.errors).toEqual([]);
  });

  it("recovers successfully when the element plays the fresh source", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();

    env.engine.emit("playing");
    expect(env.controller.isRecovering()).toBe(false);
    expect(env.errors).toEqual([]);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "recovered",
      trackKey: "youtube:dQw4w9WgXcQ",
      attemptsUsed: 1,
      maxAttempts: 2,
    });
  });

  it("does not retry permanent resolution failures", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubReject(
      new PlaybackResolutionError(
        { provider: "youtube", providerTrackId: "dQw4w9WgXcQ" },
        "resolve",
        "Video is private",
      ),
    );
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();

    // Initial resolve + the single started round; no second round.
    expect(env.resolveSource).toHaveBeenCalledTimes(2);
    expect(env.engine.loaded).toHaveLength(1);
    expect(pendingRecoveryTimers(env)).toBe(0);
    expect(env.errors).toEqual([
      { kind: "unavailable", message: "Video is private" },
    ]);
    expect(env.controller.isRecovering()).toBe(false);
  });

  it("retries transient resolution failures within budget", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubReject(
      new ExtractorError("youtube", "info", "connection reset", {
        retryable: true,
      }),
    );
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();
    // Round 1 failed transiently: a second round is scheduled, nothing final.
    expect(env.errors).toEqual([]);
    expect(env.controller.isRecovering()).toBe(true);

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/c.m4a"));
    runRecoveryTimers(env);
    await flush();
    expect(env.resolveSource).toHaveBeenCalledTimes(3);
    expect(env.engine.loaded).toHaveLength(2);
    env.engine.emit("playing");
    expect(env.errors).toEqual([]);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "recovered",
      attemptsUsed: 2,
    });
  });

  it("exhausts the budget on persistent failure and reports once", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubReject(new Error("fetch failed"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();
    env.stubReject(new Error("fetch failed"));
    // Second round runs after the first round's resolve failed.
    runRecoveryTimers(env);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(3);
    expect(env.engine.loaded).toHaveLength(1);
    expect(env.errors).toEqual([
      { kind: "playback", message: "Playback failed unexpectedly." },
    ]);
    expect(env.controller.isRecovering()).toBe(false);
    expect(pendingRecoveryTimers(env)).toBe(0);
  });

  it("ignores autoplay blocks (they need a gesture, not a retry)", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emitError({
      error: new PlayerError("autoplay", "Tap play again to start."),
    });
    await flush();
    runRecoveryTimers(env);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.engine.loaded).toHaveLength(1);
    expect(env.errors).toEqual([]);
    expect(env.controller.isRecovering()).toBe(false);
  });

  it("logs no recovery lifecycle for a pure policy block", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    const records: LogRecord[] = [];
    const restore = setLogSink((record) => {
      records.push(record);
    });
    try {
      env.engine.emitError({
        error: new PlayerError("autoplay", "Tap play again to start."),
      });
      await flush();
      runRecoveryTimers(env);
      await flush();
    } finally {
      restore();
    }

    expect(
      records.filter(
        (record) =>
          record.event === "playback_recovery_started" ||
          record.event === "playback_recovery_failed" ||
          record.event === "playback_recovery_attempt" ||
          record.event === "playback_recovery_succeeded",
      ),
    ).toEqual([]);
    expect(pendingRecoveryTimers(env)).toBe(0);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "idle",
      attemptsUsed: 0,
      lastFailureCategory: null,
    });
  });

  it("keeps policy-block noise out of a genuine source cycle", async () => {
    // Incident regression: element SRC_NOT_SUPPORTED starts a legitimate
    // source cycle, but gesture-less round autoplays reject with
    // NotAllowedError. That noise must neither consume budget nor
    // overwrite the terminal source outcome.
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emitError({
      error: new PlayerError(
        "unavailable",
        "This stream could not be played.",
        4,
      ),
    });
    expect(env.controller.isRecovering()).toBe(true);

    // Round 1 reloads with autoplay; the policy rejection arrives first.
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    runRecoveryTimers(env);
    await flush();
    env.engine.emitError({
      error: new PlayerError(
        "autoplay",
        "Playback was blocked by the browser. Tap play again to start.",
      ),
    });
    await flush();
    expect(env.errors).toEqual([]);
    expect(env.controller.isRecovering()).toBe(true);

    // Round 2: the source is still dead at element level. The failure
    // schedules round 2; running timers executes it (resolve + reload).
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/c.m4a"));
    env.engine.emitError({
      error: new PlayerError(
        "unavailable",
        "This stream could not be played.",
        4,
      ),
    });
    expect(env.controller.isRecovering()).toBe(true);
    runRecoveryTimers(env);
    await flush();
    expect(env.resolveSource).toHaveBeenCalledTimes(3);
    expect(env.engine.loaded).toHaveLength(3);

    // The reloaded source fails again: budget exhausted with the honest
    // source outcome — never the policy-block message.
    env.engine.emitError({
      error: new PlayerError(
        "unavailable",
        "This stream could not be played.",
        4,
      ),
    });
    await flush();

    expect(env.errors).toEqual([
      { kind: "unavailable", message: "This stream could not be played." },
    ]);
    expect(env.controller.isRecovering()).toBe(false);
    // One initial resolve plus exactly two bounded rounds.
    expect(env.resolveSource).toHaveBeenCalledTimes(3);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "failed",
      attemptsUsed: 2,
      maxAttempts: 2,
      lastFailureCategory: "source",
    });
  });

  it("resumes from a policy block on the next user ensurePlaying", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emitError({
      error: new PlayerError("autoplay", "Tap play again to start."),
    });
    await flush();
    expect(env.controller.isRecovering()).toBe(false);

    // Fresh user gesture: single-shot play, no re-resolve (the loaded
    // source is still valid), no recovery cycle.
    await env.controller.ensurePlaying();
    expect(env.engine.playCalls).toBe(1);
    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.controller.isRecovering()).toBe(false);

    env.engine.emit("playing");
    expect(env.errors).toEqual([]);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "idle",
    });
  });

  it("re-resolves a suppressed dead source on user retry after exhaustion", async () => {
    // Tapping Play after terminal source failure must not replay the
    // known-dead URL: one fresh gesture-backed resolution instead, with
    // no spontaneous recovery budget consumed.
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError({
      error: new PlayerError(
        "unavailable",
        "This stream could not be played.",
        4,
      ),
    });
    runRecoveryTimers(env);
    await flush();
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/c.m4a"));
    env.engine.emitError({
      error: new PlayerError(
        "unavailable",
        "This stream could not be played.",
        4,
      ),
    });
    runRecoveryTimers(env);
    await flush();
    env.engine.emitError({
      error: new PlayerError(
        "unavailable",
        "This stream could not be played.",
        4,
      ),
    });
    await flush();
    expect(env.controller.isRecovering()).toBe(false);
    expect(env.resolveSource).toHaveBeenCalledTimes(3);
    expect(env.errors).toEqual([
      { kind: "unavailable", message: "This stream could not be played." },
    ]);

    // User tap: the dead URL is skipped, one fresh resolve loads.
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/d.m4a"));
    await env.controller.ensurePlaying();
    expect(env.resolveSource).toHaveBeenCalledTimes(4);
    expect(env.engine.loaded).toHaveLength(4);
    expect(env.engine.loaded[3]?.track.streamUrl).toBe(
      "https://cdn.example/d.m4a",
    );
    expect(env.controller.isRecovering()).toBe(false);
    expect(pendingRecoveryTimers(env)).toBe(0);

    env.engine.emit("playing");
    expect(env.errors).toHaveLength(1);
  });

  it("reports diagnostics across the cycle lifecycle", async () => {
    const env = setupRecovery();
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "idle",
      trackKey: null,
    });

    await loadPlaying(env);
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError({ error: new PlayerError("playback", "net", 2) });
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "backoff",
      trackKey: "youtube:dQw4w9WgXcQ",
      attemptsUsed: 0,
      lastFailureCategory: "transient",
    });

    runRecoveryTimers(env);
    await flush();
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "awaiting-outcome",
      attemptsUsed: 1,
    });
  });
});

describe("expiry recovery", () => {
  it("re-resolves on resume after expiry while paused", async () => {
    const env = setupRecovery();
    const first = sourceFor("dQw4w9WgXcQ", "https://cdn.example/a.m4a");
    env.stubResolve(first);
    env.controller.loadTrack(youtubeTrack());
    await flush();
    env.engine.emit("playing");
    env.controller.pause();

    // TTL lapses while paused; the stale URL must never replay.
    first.expiresAt = new Date(Date.now() - 1000);
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/fresh.m4a"));
    await env.controller.ensurePlaying();

    expect(env.resolveSource).toHaveBeenCalledTimes(2);
    expect(env.engine.loaded).toHaveLength(2);
    expect(env.engine.loaded[1]?.track.streamUrl).toBe(
      "https://cdn.example/fresh.m4a",
    );
    expect(env.errors).toEqual([]);
  });

  it("recovers an expired mid-playback source with a fresh URL at position", async () => {
    const env = setupRecovery();
    const dying = sourceFor("dQw4w9WgXcQ", "https://cdn.example/old.m4a");
    env.stubResolve(dying);
    env.controller.loadTrack(youtubeTrack());
    await flush();
    env.engine.emit("playing");

    dying.expiresAt = new Date(Date.now() - 1000);
    env.engine.position = 100;
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/new.m4a"));
    env.engine.emitError({ error: new PlayerError("playback", "dead", 2) });
    runRecoveryTimers(env);
    await flush();

    expect(env.engine.loaded).toHaveLength(2);
    expect(env.engine.loaded[1]?.track.streamUrl).toBe(
      "https://cdn.example/new.m4a",
    );
    expect(env.engine.seeks).toEqual([100]);
    expect(env.errors).toEqual([]);
  });
});

describe("stall detection", () => {
  it("does not recover when waiting is followed by progress", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emit("waiting");
    env.clock.advance(2000);
    env.engine.emit("timeupdate", { currentTime: 10 });
    env.clock.advance(2000);
    env.engine.emit("timeupdate", { currentTime: 20 });
    env.clock.advance(2000);
    env.engine.emit("timeupdate", { currentTime: 30 });
    // The armed stall timer fires with recent progress: re-arm, no cycle.
    env.timers.runNext();
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.controller.isRecovering()).toBe(false);
    expect(env.errors).toEqual([]);
  });

  it("recovers on waiting plus sustained no-progress", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.engine.position = 100;

    env.engine.emit("waiting");
    env.engine.emit("timeupdate", { currentTime: 100 });
    env.engine.emit("timeupdate", { currentTime: 100 });
    env.clock.advance(5000);
    env.timers.runNext();
    expect(env.controller.isRecovering()).toBe(true);

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    runRecoveryTimers(env);
    await flush();
    expect(env.resolveSource).toHaveBeenCalledTimes(2);
    expect(env.engine.loaded).toHaveLength(2);
    expect(env.engine.seeks).toEqual([100]);
  });

  it("treats stalled like waiting and collapses simultaneous bursts", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emit("error", {});
    env.engine.emit("waiting");
    env.engine.emit("stalled");
    expect(env.controller.isRecovering()).toBe(true);
    runRecoveryTimers(env);
    await flush();

    // One cycle despite three signals at once.
    expect(env.resolveSource).toHaveBeenCalledTimes(2);
    expect(env.engine.loaded).toHaveLength(2);
  });

  it("does not recover while paused", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emit("waiting");
    env.controller.pause();
    expect(env.timers.pendingCount()).toBe(0);
    env.clock.advance(10000);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.controller.isRecovering()).toBe(false);
  });

  it("does not recover for a seek followed by progress", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.controller.notifySeekRequest(240);
    env.clock.advance(1000);
    env.engine.emit("timeupdate", { currentTime: 240 });
    env.engine.emit("playing");
    env.clock.advance(4000);
    // Any armed timer observes post-seek progress: no cycle.
    drainOnce(env);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.controller.isRecovering()).toBe(false);
  });

  it("does not recover after ended", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emit("ended");
    env.clock.advance(10000);
    drainOnce(env);
    await flush();

    expect(env.timers.pendingCount()).toBe(0);
    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.controller.isRecovering()).toBe(false);
  });

  it("ignores total event silence shortly after startup buffering", async () => {
    const env = setupRecovery();
    env.stubResolve(sourceFor("dQw4w9WgXcQ"));
    env.controller.loadTrack(youtubeTrack());
    await flush();
    // Loaded but never played: buffering without a first playing event
    // must not count as a stall.
    env.clock.advance(10000);
    drainOnce(env);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.controller.isRecovering()).toBe(false);
  });
});

describe("recovery races", () => {
  it("pause during recovery loads paused and never autoplays", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    expect(env.controller.isRecovering()).toBe(true);
    env.controller.pause();

    runRecoveryTimers(env);
    await flush();
    expect(env.engine.loaded).toHaveLength(2);
    expect(env.engine.loaded[1]).toMatchObject({ autoplay: false });
    expect(env.engine.playCalls).toBe(0);

    // Metadata completes the paused load; playback stays paused.
    env.engine.emit("loadedmetadata", { duration: 213 });
    expect(env.controller.isRecovering()).toBe(false);
    expect(env.errors).toEqual([]);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "recovered",
    });
  });

  it("stop during recovery prevents any load or error", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emitError();
    expect(env.controller.isRecovering()).toBe(true);
    env.controller.stop();

    runRecoveryTimers(env);
    await flush();
    expect(env.engine.loaded).toHaveLength(1);
    expect(env.errors).toEqual([]);
    expect(env.controller.isRecovering()).toBe(false);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "idle",
    });
    env.engine.emitError();
    await flush();
    expect(env.resolveSource).toHaveBeenCalledTimes(1);
  });

  it("next during recovery keeps the new track and drops the stale round", async () => {
    const env = setupRecovery();
    await loadPlaying(env, "https://cdn.example/a.m4a");

    env.engine.emitError();
    expect(env.controller.isRecovering()).toBe(true);
    env.stubResolve(sourceFor("bbbbbbbbbbb", "https://cdn.example/b.m4a"));
    env.controller.loadTrack(youtubeTrack("bbbbbbbbbbb"));
    runRecoveryTimers(env);
    await flush();

    const urls = env.engine.loaded.map((entry) => entry.track.streamUrl);
    expect(urls).toEqual([
      "https://cdn.example/a.m4a",
      "https://cdn.example/b.m4a",
    ]);
    expect(env.errors).toEqual([]);
    expect(env.controller.isRecovering()).toBe(false);
  });

  it("clears stall and backoff timers on shutdown", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    expect(env.controller.isRecovering()).toBe(true);
    expect(env.timers.pendingCount()).toBeGreaterThan(0);

    env.controller.shutdown();
    expect(env.timers.pendingCount()).toBe(0);
    expect(env.controller.isRecovering()).toBe(false);

    env.clock.advance(30000);
    drainOnce(env);
    await flush();
    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.engine.loaded).toHaveLength(1);
    expect(env.errors).toEqual([]);
  });

  it("cancels a pending recovery cycle on ended", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.engine.emitError();
    expect(env.controller.isRecovering()).toBe(true);

    env.engine.emit("ended");
    expect(env.controller.isRecovering()).toBe(false);
    expect(env.timers.pendingCount()).toBe(0);
    runRecoveryTimers(env);
    await flush();
    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    expect(env.engine.loaded).toHaveLength(1);
    expect(env.errors).toEqual([]);
  });

  it("drops a stale in-flight resolve superseded by a new play", async () => {
    const env = setupRecovery();
    await loadPlaying(env, "https://cdn.example/a.m4a");

    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    env.engine.emitError();
    // Round 1 starts resolving but hangs.
    env.resolveSource.mockImplementationOnce(() => gate);
    runRecoveryTimers(env);

    env.stubResolve(sourceFor("bbbbbbbbbbb", "https://cdn.example/b.m4a"));
    env.controller.loadTrack(youtubeTrack("bbbbbbbbbbb"));
    release({ url: "https://cdn.example/stale.m4a" });
    await flush();
    await flush();

    const urls = env.engine.loaded.map((entry) => entry.track.streamUrl);
    expect(urls).toEqual([
      "https://cdn.example/a.m4a",
      "https://cdn.example/b.m4a",
    ]);
    expect(env.errors).toEqual([]);
  });

  it("shutdown invalidates recovery and detaches every listener", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emitError();
    expect(env.controller.isRecovering()).toBe(true);
    env.controller.shutdown();

    runRecoveryTimers(env);
    await flush();
    expect(env.engine.loaded).toHaveLength(1);
    expect(env.errors).toEqual([]);
    env.engine.emitError();
    await flush();
    expect(env.resolveSource).toHaveBeenCalledTimes(1);
    for (const event of [
      "error",
      "timeupdate",
      "waiting",
      "stalled",
      "playing",
      "pause",
      "ended",
      "loadedmetadata",
      "canplay",
    ] as const) {
      expect(env.engine.listenerCount(event)).toBe(0);
    }
  });

  it("collapses duplicate failure bursts into one round", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    // Same tick, same round: these add no extra cycles or rounds.
    env.engine.emitError();
    env.engine.emit("waiting");
    env.engine.emit("stalled");
    runRecoveryTimers(env);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(2);
    expect(env.engine.loaded).toHaveLength(2);
  });
});

describe("recovery position", () => {
  it("resumes around the failure position", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.engine.position = 100;

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();

    expect(env.engine.seeks).toEqual([100]);
  });

  it("lets the latest user seek win over the captured position", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.engine.position = 100;

    let release!: (source: { url: string }) => void;
    const gate = new Promise<{ url: string }>((resolve) => {
      release = resolve;
    });
    env.engine.emitError();
    env.resolveSource.mockImplementationOnce(() => gate);
    runRecoveryTimers(env);

    env.controller.notifySeekRequest(80);
    release({ url: "https://cdn.example/b.m4a" });
    await flush();
    await flush();

    expect(env.engine.seeks).toEqual([80]);
  });

  it("clamps the resume position to the known duration", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.engine.position = 250;
    env.engine.sourceDuration = 200;

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();

    expect(env.engine.seeks).toEqual([200]);
  });

  it("passes the position through when duration is unknown", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.engine.position = 250;
    env.engine.sourceDuration = 0;

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();

    expect(env.engine.seeks).toEqual([250]);
  });
});

describe("network recovery", () => {
  it("recovers when the network returns mid-cycle", async () => {
    const env = setupRecovery();
    await loadPlaying(env);
    env.engine.position = 100;

    env.stubReject(new Error("fetch failed"));
    env.engine.emitError({ error: new PlayerError("playback", "net", 2) });
    runRecoveryTimers(env);
    await flush();
    // First round failed offline: still recovering, nothing final.
    expect(env.errors).toEqual([]);
    expect(env.controller.isRecovering()).toBe(true);

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    runRecoveryTimers(env);
    await flush();
    expect(env.resolveSource).toHaveBeenCalledTimes(3);
    expect(env.engine.loaded).toHaveLength(2);
    expect(env.engine.seeks).toEqual([100]);
    env.engine.emit("playing");
    expect(env.errors).toEqual([]);
  });

  it("ends boundedly when the network stays down", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubReject(new Error("fetch failed"));
    env.engine.emitError({ error: new PlayerError("playback", "net", 2) });
    runRecoveryTimers(env);
    await flush();
    env.stubReject(new Error("fetch failed"));
    runRecoveryTimers(env);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(3);
    expect(env.engine.loaded).toHaveLength(1);
    expect(env.errors).toHaveLength(1);
    expect(env.controller.isRecovering()).toBe(false);
    expect(pendingRecoveryTimers(env)).toBe(0);
  });
});

describe("recovery state reset", () => {
  it("grants a fresh budget after a successful recovery", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();
    env.engine.emit("playing");

    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/c.m4a"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();
    env.engine.emit("playing");

    expect(env.resolveSource).toHaveBeenCalledTimes(3);
    expect(env.errors).toEqual([]);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "recovered",
      attemptsUsed: 1,
    });
  });

  it("resets recovery state on track change", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    env.engine.emitError();
    expect(env.controller.isRecovering()).toBe(true);
    env.stubResolve(sourceFor("bbbbbbbbbbb", "https://cdn.example/b.m4a"));
    env.controller.loadTrack(youtubeTrack("bbbbbbbbbbb"));
    await flush();

    expect(env.controller.isRecovering()).toBe(false);
    expect(env.controller.getRecoveryDiagnostics()).toMatchObject({
      phase: "idle",
      trackKey: null,
      attemptsUsed: 0,
    });
  });

  it("retries a new generation of the same track after a final failure", async () => {
    const env = setupRecovery();
    await loadPlaying(env);

    // Exhaust the budget: two transient rounds, then final.
    env.stubReject(new Error("fetch failed"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();
    env.stubReject(new Error("fetch failed"));
    runRecoveryTimers(env);
    await flush();
    expect(env.errors).toHaveLength(1);
    const callsAfterFinal = env.resolveSource.mock.calls.length;

    // Same track re-requested by the user is a new generation: fresh cycle.
    env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/z.m4a"));
    env.controller.loadTrack(youtubeTrack());
    await flush();
    env.engine.emitError();
    expect(env.controller.isRecovering()).toBe(true);
    expect(env.resolveSource.mock.calls.length).toBeGreaterThan(
      callsAfterFinal,
    );
  });
});

describe("multi-source and provider invariants", () => {
  it("re-resolves the same youtube source without touching providers", async () => {
    const env = setupRecovery();
    const track = {
      ...youtubeTrack("vid1"),
      metadata: {
        sources: [
          { source: "youtube", id: "vid1" },
          { source: "spotify", id: "sp1" },
        ],
      },
    };
    env.stubResolve(sourceFor("vid1", "https://cdn.example/a.m4a"));
    env.controller.loadTrack(track);
    await flush();
    env.engine.emit("playing");

    env.stubResolve(sourceFor("vid1", "https://cdn.example/b.m4a"));
    env.engine.emitError();
    runRecoveryTimers(env);
    await flush();

    expect(env.resolveSource).toHaveBeenCalledTimes(2);
    for (const call of env.resolveSource.mock.calls) {
      expect(call[0]).toMatchObject({ source: "youtube", id: "vid1" });
    }
    // Primary source identity untouched by recovery.
    expect(env.engine.loaded[1]?.track.provider).toBe("youtube");
    expect(env.engine.loaded[1]?.track.providerTrackId).toBe("vid1");
    expect(env.errors).toEqual([]);
  });

  it("never loads previews and never retries match-stage failures", async () => {
    const env = setupRecovery();
    const track = {
      id: "spotify-1",
      provider: "spotify",
      providerTrackId: "spotify-1",
      title: "Song",
      artistId: "sa-1",
      artistName: "Artist",
      previewUrl: "https://preview.example/spotify-1.mp3",
    };
    env.controller.loadTrack(track);
    await flush();

    expect(env.engine.loaded).toHaveLength(0);
    expect(env.errors).toHaveLength(1);
    // A later engine error with no active source starts no cycle.
    env.engine.emitError();
    await flush();
    runRecoveryTimers(env);
    await flush();
    expect(env.resolveSource).not.toHaveBeenCalled();
    expect(env.controller.isRecovering()).toBe(false);
  });
});

describe("recovery diagnostics", () => {
  function captureLogs(): {
    records: LogRecord[];
    restore: () => void;
  } {
    const records: LogRecord[] = [];
    const restore = setLogSink((record) => {
      records.push(record);
    });
    setLogLevel("debug");
    return { records, restore };
  }

  it("emits warn on start and info on success", async () => {
    const env = setupRecovery();
    const { records, restore } = captureLogs();
    try {
      await loadPlaying(env);
      env.stubResolve(sourceFor("dQw4w9WgXcQ", "https://cdn.example/b.m4a"));
      env.engine.emitError({ error: new PlayerError("playback", "net", 2) });
      runRecoveryTimers(env);
      await flush();
      env.engine.emit("playing");

      const events = records.map((record) => record.event);
      expect(events).toEqual([
        "playback_recovery_started",
        "playback_recovery_succeeded",
      ]);
      expect(records[0]).toMatchObject({
        level: "warn",
        fields: expect.objectContaining({ trackKey: "youtube:dQw4w9WgXcQ" }),
      });
      expect(records[1]).toMatchObject({
        level: "info",
        fields: expect.objectContaining({
          trackKey: "youtube:dQw4w9WgXcQ",
          attempts: 1,
        }),
      });
      for (const record of records) {
        expect(JSON.stringify(record)).not.toContain("cdn.example");
      }
    } finally {
      restore();
    }
  });

  it("emits an error record on exhaustion without source URLs", async () => {
    const env = setupRecovery();
    const { records, restore } = captureLogs();
    try {
      await loadPlaying(env);
      env.stubReject(new Error("fetch failed"));
      env.engine.emitError({ error: new PlayerError("playback", "net", 2) });
      runRecoveryTimers(env);
      await flush();
      env.stubReject(new Error("fetch failed"));
      runRecoveryTimers(env);
      await flush();

      const failed = records.filter(
        (record) => record.event === "playback_recovery_failed",
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        level: "error",
        fields: expect.objectContaining({ attempts: 2 }),
      });
      const attempts = records.filter(
        (record) => record.event === "playback_recovery_attempt",
      );
      expect(attempts.length).toBeGreaterThanOrEqual(1);
      expect(attempts[0]?.level).toBe("debug");
      for (const record of records) {
        expect(JSON.stringify(record)).not.toContain("cdn.example");
        expect(JSON.stringify(record)).not.toContain("googlevideo");
      }
    } finally {
      restore();
    }
  });
});
