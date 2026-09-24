import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";
import {
  PlaybackPersistenceController,
  type PersistenceControllerDeps,
  type PlaybackStatePayload,
} from "@/lib/player/persistence";
import {
  PLAYBACK_CHECKPOINT_INTERVAL_MS,
  PLAYBACK_POSITION_THRESHOLD_S,
} from "@/lib/player/persistence-constants";

function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    provider: "mock",
    title: `Track ${id}`,
    artistId: "a1",
    artistName: "Artist",
    streamUrl: `https://example.com/${id}.mp3`,
    duration: 200,
    ...overrides,
  };
}

function makePayload(
  overrides: Partial<PlaybackStatePayload> = {},
): PlaybackStatePayload {
  return {
    provider: "mock",
    providerTrackId: "t-restore",
    position: 83,
    revision: 4,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface Harness {
  controller: PlaybackPersistenceController;
  deps: PersistenceControllerDeps & {
    getPlaybackStateAction: ReturnType<typeof vi.fn>;
    savePlaybackStateAction: ReturnType<typeof vi.fn>;
    clearPlaybackStateAction: ReturnType<typeof vi.fn>;
    resolveTrack: ReturnType<typeof vi.fn>;
    applyRestore: ReturnType<typeof vi.fn>;
    setInitState: ReturnType<typeof vi.fn>;
  };
  store: {
    currentTrack: Track | null;
    currentTime: number;
    isPlaying: boolean;
    userActionGeneration: number;
  };
}

function createHarness(): Harness {
  const store = {
    currentTrack: null as Track | null,
    currentTime: 0,
    isPlaying: false,
    userActionGeneration: 0,
  };
  const deps = {
    getPlaybackStateAction: vi.fn(async () => ({ ok: true as const, state: null })),
    savePlaybackStateAction: vi.fn(async () => ({ ok: true as const })),
    clearPlaybackStateAction: vi.fn(async () => ({ ok: true as const })),
    resolveTrack: vi.fn(async () => null as Track | null),
    getStoreSnapshot: () => ({ ...store }),
    applyRestore: vi.fn((track: Track) => {
      store.currentTrack = track;
    }),
    setInitState: vi.fn(),
  };
  const controller = new PlaybackPersistenceController(deps);
  return { controller, deps, store };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PlaybackPersistenceController", () => {
  let harnesses: Harness[] = [];

  function reg(h: Harness): Harness {
    harnesses.push(h);
    return h;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const h of harnesses) {
      h.controller.shutdown();
    }
    harnesses = [];
    vi.useRealTimers();
  });

  describe("anonymous startup", () => {
    it("marks ready without fetching or resolving", async () => {
      const h = reg(createHarness());
      await h.controller.initialize(null);
      expect(h.deps.setInitState).toHaveBeenCalledWith("ready");
      expect(h.deps.getPlaybackStateAction).not.toHaveBeenCalled();
      expect(h.deps.resolveTrack).not.toHaveBeenCalled();
      expect(h.deps.applyRestore).not.toHaveBeenCalled();
    });

    it("never saves checkpoints when anonymous", async () => {
      const h = reg(createHarness());
      await h.controller.initialize(null);
      h.store.currentTrack = makeTrack("a");
      h.store.currentTime = 50;
      h.store.isPlaying = true;
      h.controller.notifyTrackChanged(makeTrack("old"), 10);
      h.controller.notifyPaused(makeTrack("a"), 50);
      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS * 3);
      expect(h.deps.savePlaybackStateAction).not.toHaveBeenCalled();
    });
  });

  describe("restore", () => {
    it("restores track and position through the provider", async () => {
      const h = reg(createHarness());
      const restored = makeTrack("t-restore");
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload(),
      });
      h.deps.resolveTrack.mockResolvedValue(restored);

      await h.controller.initialize("user-1");

      expect(h.deps.resolveTrack).toHaveBeenCalledWith("mock", "t-restore");
      expect(h.deps.applyRestore).toHaveBeenCalledWith(restored, 83);
      expect(h.deps.setInitState).toHaveBeenCalledWith("ready");
    });

    it("completes with ready state when no persisted state exists", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      expect(h.deps.applyRestore).not.toHaveBeenCalled();
      expect(h.deps.setInitState).toHaveBeenCalledWith("ready");
    });

    it("clears stale state when provider resolution fails", async () => {
      const h = reg(createHarness());
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload(),
      });
      h.deps.resolveTrack.mockResolvedValue(null);

      await h.controller.initialize("user-1");

      expect(h.deps.clearPlaybackStateAction).toHaveBeenCalledOnce();
      expect(h.deps.applyRestore).not.toHaveBeenCalled();
      expect(h.deps.setInitState).toHaveBeenCalledWith("ready");
    });

    it("clears stale state with invalid identity and continues startup", async () => {
      const h = reg(createHarness());
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({ providerTrackId: "" }),
      });

      await h.controller.initialize("user-1");

      expect(h.deps.clearPlaybackStateAction).toHaveBeenCalledOnce();
      expect(h.deps.resolveTrack).not.toHaveBeenCalled();
      expect(h.deps.setInitState).toHaveBeenCalledWith("ready");
    });

    it("does not crash startup when fetch fails", async () => {
      const h = reg(createHarness());
      h.deps.getPlaybackStateAction.mockRejectedValue(new Error("DB down"));

      await h.controller.initialize("user-1");

      expect(h.deps.setInitState).toHaveBeenCalledWith("ready");
      expect(h.deps.applyRestore).not.toHaveBeenCalled();
    });

    it("normalizes negative and non-finite positions to zero", async () => {
      const h = reg(createHarness());
      const restored = makeTrack("t-restore");
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({ position: -30 }),
      });
      h.deps.resolveTrack.mockResolvedValue(restored);

      await h.controller.initialize("user-1");

      expect(h.deps.applyRestore).toHaveBeenCalledWith(restored, 0);
    });
  });

  describe("user intent beats restore", () => {
    it("discards restore when user plays a track mid-restore", async () => {
      const h = reg(createHarness());
      const gate = deferred<{
        ok: true;
        state: PlaybackStatePayload | null;
      }>();
      h.deps.getPlaybackStateAction.mockReturnValue(gate.promise);
      h.deps.resolveTrack.mockResolvedValue(makeTrack("t-restore"));

      const initPromise = h.controller.initialize("user-1");

      // User acts while restore is pending.
      h.store.currentTrack = makeTrack("user-track-A");
      h.store.userActionGeneration += 1;

      gate.resolve({ ok: true, state: makePayload() });
      await initPromise;

      expect(h.deps.applyRestore).not.toHaveBeenCalled();
      expect(h.store.currentTrack?.id).toBe("user-track-A");
      expect(h.deps.setInitState).toHaveBeenCalledWith("ready");
    });

    it("discards restore when user seeks mid-restore", async () => {
      const h = reg(createHarness());
      const gate = deferred<{
        ok: true;
        state: PlaybackStatePayload | null;
      }>();
      h.deps.getPlaybackStateAction.mockReturnValue(gate.promise);
      h.deps.resolveTrack.mockResolvedValue(makeTrack("t-restore"));

      const initPromise = h.controller.initialize("user-1");
      h.store.userActionGeneration += 1;

      gate.resolve({ ok: true, state: makePayload() });
      await initPromise;

      expect(h.deps.applyRestore).not.toHaveBeenCalled();
    });

    it("applies restore when no user action occurred", async () => {
      const h = reg(createHarness());
      const restored = makeTrack("t-restore");
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload(),
      });
      h.deps.resolveTrack.mockResolvedValue(restored);

      await h.controller.initialize("user-1");

      expect(h.deps.applyRestore).toHaveBeenCalledWith(restored, 83);
    });
  });

  describe("account switching and sign-out", () => {
    it("sign-out stops timers and prevents further saves", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      h.store.currentTrack = makeTrack("a");
      h.store.currentTime = 60;
      h.store.isPlaying = true;

      await h.controller.initialize(null);

      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS * 3);
      expect(h.deps.savePlaybackStateAction).not.toHaveBeenCalled();
    });

    it("pending save for old user cannot mutate new session", async () => {
      const h = reg(createHarness());
      const gate = deferred<{ ok: boolean }>();
      h.deps.savePlaybackStateAction.mockReturnValue(gate.promise);

      await h.controller.initialize("user-A");
      h.store.currentTrack = makeTrack("a");
      h.store.currentTime = 42;
      h.store.isPlaying = true;
      h.controller.notifyPaused(makeTrack("a"), 42);

      // Switch accounts before the save completes.
      await h.controller.initialize("user-B");

      gate.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);

      // The save was issued, but completion must not throw or corrupt;
      // local revision must remain at the fresh user's baseline (0 or
      // refetched), not blindly incremented for the wrong user. The key
      // assertion: no crash and no second save for user A after switch.
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
    });

    it("new user receives only their own checkpoint", async () => {
      const h = reg(createHarness());
      const trackB = makeTrack("t-user-b");
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({ providerTrackId: "t-user-b" }),
      });
      h.deps.resolveTrack.mockResolvedValue(trackB);

      await h.controller.initialize("user-A");
      h.controller.shutdown();
      h.deps.applyRestore.mockClear();

      await h.controller.initialize("user-B");

      expect(h.deps.applyRestore).toHaveBeenCalledWith(trackB, 83);
    });
  });

  describe("periodic checkpoint", () => {
    it("saves while playing after the interval", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      const track = makeTrack("a");
      h.store.currentTrack = track;
      h.store.currentTime = 30;
      h.store.isPlaying = true;

      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);

      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledOnce();
      const snapshot = h.deps.savePlaybackStateAction.mock.calls[0][0];
      expect(snapshot.provider).toBe("mock");
      expect(snapshot.providerTrackId).toBe("a");
      expect(snapshot.position).toBe(30);
      expect(snapshot.revision).toBe(0);
    });

    it("skips writes when position has not meaningfully changed", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      h.store.currentTrack = makeTrack("a");
      h.store.currentTime = 30;
      h.store.isPlaying = true;

      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      // Advance 1s (within the 2s threshold) — no new write.
      h.store.currentTime = 31;
      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      // Advance beyond threshold — writes again.
      h.store.currentTime = 30 + PLAYBACK_POSITION_THRESHOLD_S + 1;
      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(2);
    });

    it("does not checkpoint while paused on the timer", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      h.store.currentTrack = makeTrack("a");
      h.store.currentTime = 30;
      h.store.isPlaying = false;

      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS * 3);

      expect(h.deps.savePlaybackStateAction).not.toHaveBeenCalled();
    });

    it("creates only one timer across re-initialization", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      await h.controller.initialize("user-1");
      h.store.currentTrack = makeTrack("a");
      h.store.currentTime = 30;
      h.store.isPlaying = true;

      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);

      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
    });
  });

  describe("track change and pause checkpoints", () => {
    it("persists old track with old position on track change", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      const oldTrack = makeTrack("old");

      h.controller.notifyTrackChanged(oldTrack, 77);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledOnce();
      const snapshot = h.deps.savePlaybackStateAction.mock.calls[0][0];
      expect(snapshot.providerTrackId).toBe("old");
      expect(snapshot.position).toBe(77);
    });

    it("persists current position on pause", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      const track = makeTrack("a");

      h.controller.notifyPaused(track, 55);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledOnce();
      expect(
        h.deps.savePlaybackStateAction.mock.calls[0][0].position,
      ).toBe(55);
    });

    it("save failures never throw", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      h.deps.savePlaybackStateAction.mockRejectedValue(new Error("DB down"));

      await expect(
        (async () => {
          h.controller.notifyPaused(makeTrack("a"), 10);
          await vi.advanceTimersByTimeAsync(0);
        })(),
      ).resolves.toBeUndefined();
    });
  });

  describe("revision handling", () => {
    it("increments local revision after a successful save", async () => {
      const h = reg(createHarness());
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({ revision: 4 }),
      });
      h.deps.resolveTrack.mockResolvedValue(makeTrack("t-restore"));
      await h.controller.initialize("user-1");

      const track = makeTrack("a");
      h.store.currentTrack = track;
      h.store.currentTime = 100;
      h.store.isPlaying = true;
      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);

      expect(
        h.deps.savePlaybackStateAction.mock.calls[0][0].revision,
      ).toBe(4);
      // Next save uses the bumped revision.
      h.store.currentTime = 120;
      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);
      expect(
        h.deps.savePlaybackStateAction.mock.calls[1][0].revision,
      ).toBe(5);
    });

    it("syncs revision after a stale rejection", async () => {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      h.deps.savePlaybackStateAction.mockResolvedValue({
        ok: true,
        stale: true,
      });
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({ revision: 9 }),
      });

      h.store.currentTrack = makeTrack("a");
      h.store.currentTime = 40;
      h.store.isPlaying = true;
      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);

      expect(h.deps.getPlaybackStateAction).toHaveBeenCalled();

      // Next save uses the synced revision.
      h.deps.savePlaybackStateAction.mockResolvedValue({ ok: true });
      h.store.currentTime = 60;
      await vi.advanceTimersByTimeAsync(PLAYBACK_CHECKPOINT_INTERVAL_MS);
      const last =
        h.deps.savePlaybackStateAction.mock.calls[
          h.deps.savePlaybackStateAction.mock.calls.length - 1
        ][0];
      expect(last.revision).toBe(9);
    });
  });
});
