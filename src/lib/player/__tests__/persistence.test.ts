import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";
import {
  PlaybackPersistenceController,
  isSeekJump,
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
    applyQueueRestore: ReturnType<typeof vi.fn>;
    setInitState: ReturnType<typeof vi.fn>;
  };
  store: {
    currentTrack: Track | null;
    currentTime: number;
    isPlaying: boolean;
    userActionGeneration: number;
    queue: Track[];
    playOrder: number[];
    position: number;
    shuffle: boolean;
    repeat: "off" | "all" | "one";
    volume: number;
    muted: boolean;
  };
}

function createHarness(): Harness {
  const store: Harness["store"] = {
    currentTrack: null as Track | null,
    currentTime: 0,
    isPlaying: false,
    userActionGeneration: 0,
    queue: [],
    playOrder: [],
    position: -1,
    shuffle: false,
    repeat: "off",
    volume: 1,
    muted: false,
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
    applyQueueRestore: vi.fn(
      (restored: {
        tracks: Track[];
        playOrder: number[];
        position: number;
        shuffle: boolean;
        repeat: "off" | "all" | "one";
        mediaPosition: number;
        currentTrack?: Track | null;
        volume?: number;
        muted?: boolean;
      }) => {
        store.queue = restored.tracks;
        store.playOrder = restored.playOrder;
        store.position = restored.position;
        store.shuffle = restored.shuffle;
        store.repeat = restored.repeat;
        store.currentTrack = restored.currentTrack ?? null;
        store.currentTime = restored.mediaPosition;
        if (restored.volume !== undefined) store.volume = restored.volume;
        if (restored.muted !== undefined) store.muted = restored.muted;
      },
    ),
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

  describe("queue snapshot restore (Phase 40)", () => {
    function queuePayload() {
      return makePayload({
        provider: "mock",
        providerTrackId: "t-b",
        position: 12,
        revision: 2,
        queueSnapshot: {
          version: 2,
          entries: [
            {
              provider: "mock",
              providerTrackId: "t-a",
              title: "Track A",
              artistId: "a1",
              artistName: "Artist",
            },
            {
              provider: "mock",
              providerTrackId: "t-b",
              title: "Track B",
              artistId: "a1",
              artistName: "Artist",
            },
            {
              provider: "mock",
              providerTrackId: "t-c",
              title: "Track C",
              artistId: "a1",
              artistName: "Artist",
            },
          ],
          playOrder: [1, 2, 0],
          position: 1,
          mediaPosition: 34,
          shuffle: true,
          repeat: "all" as const,
          volume: 0.75,
          muted: false,
          savedAt: 1_700_000_000_000,
        },
      });
    }

    it("restores the full queue, cursor, shuffle, repeat, and position", async () => {
      const h = reg(createHarness());
      const resolved = makeTrack("t-c", { title: "Track C fresh" });
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: queuePayload(),
      });
      h.deps.resolveTrack.mockResolvedValue(resolved);

      await h.controller.initialize("user-1");

      // Only the current entry is re-resolved; the rest stay identity-only.
      expect(h.deps.resolveTrack).toHaveBeenCalledTimes(1);
      expect(h.deps.resolveTrack).toHaveBeenCalledWith("mock", "t-c");
      expect(h.deps.applyQueueRestore).toHaveBeenCalledTimes(1);
      const restored = h.deps.applyQueueRestore.mock.calls[0]?.[0];
      expect(restored?.tracks.map((t: Track) => t.providerTrackId)).toEqual([
        "t-a",
        "t-b",
        "t-c",
      ]);
      expect(restored?.playOrder).toEqual([1, 2, 0]);
      expect(restored?.position).toBe(1);
      expect(restored?.shuffle).toBe(true);
      expect(restored?.repeat).toBe("all");
      expect(restored?.mediaPosition).toBe(34);
      expect(restored?.currentTrack).toBe(resolved);
      // Legacy single-track restore must not fire alongside queue restore.
      expect(h.deps.applyRestore).not.toHaveBeenCalled();
      expect(h.deps.setInitState).toHaveBeenCalledWith("ready");
    });

    it("keeps the queue when the current entry no longer resolves", async () => {
      const h = reg(createHarness());
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: queuePayload(),
      });
      h.deps.resolveTrack.mockResolvedValue(null);

      await h.controller.initialize("user-1");

      expect(h.deps.clearPlaybackStateAction).not.toHaveBeenCalled();
      const restored = h.deps.applyQueueRestore.mock.calls[0]?.[0];
      expect(restored?.tracks).toHaveLength(3);
      // Unresolvable current: snapshot entry kept, position reset.
      expect(restored?.currentTrack?.providerTrackId).toBe("t-c");
      expect(restored?.mediaPosition).toBe(0);
    });

    it("restores an empty queue without resolving or clearing", async () => {
      const h = reg(createHarness());
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({
          queueSnapshot: {
            version: 2,
            entries: [],
            playOrder: [],
            position: -1,
            mediaPosition: 0,
            shuffle: false,
            repeat: "off" as const,
            volume: 1,
            muted: false,
            savedAt: 1_700_000_000_000,
          },
        }),
      });

      await h.controller.initialize("user-1");

      expect(h.deps.resolveTrack).not.toHaveBeenCalled();
      expect(h.deps.clearPlaybackStateAction).not.toHaveBeenCalled();
      const restored = h.deps.applyQueueRestore.mock.calls[0]?.[0];
      expect(restored?.tracks).toEqual([]);
      expect(restored?.position).toBe(-1);
    });

    it("falls back to the legacy path on an invalid snapshot version", async () => {
      const h = reg(createHarness());
      const restored = makeTrack("t-restore");
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({ queueSnapshot: { version: 999 } }),
      });
      h.deps.resolveTrack.mockResolvedValue(restored);

      await h.controller.initialize("user-1");

      expect(h.deps.applyQueueRestore).not.toHaveBeenCalled();
      expect(h.deps.applyRestore).toHaveBeenCalledWith(restored, 83);
    });
  });

  describe("queue snapshot saving (Phase 40)", () => {
    async function readyHarness() {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      vi.clearAllMocks();
      return h;
    }

    function fillStore(h: { store: Harness["store"] }) {
      h.store.queue = [makeTrack("a"), makeTrack("b")];
      h.store.playOrder = [0, 1];
      h.store.position = 0;
      h.store.currentTrack = h.store.queue[0];
      h.store.currentTime = 17;
    }

    it("saves track checkpoints with the queue snapshot attached", async () => {
      const h = await readyHarness();
      fillStore(h);
      h.controller.notifyTrackChanged(makeTrack("old"), 10);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
      const input = h.deps.savePlaybackStateAction.mock.calls[0]?.[0];
      expect(input?.provider).toBe("mock");
      expect(input?.queueSnapshot?.entries).toHaveLength(2);
      expect(input?.queueSnapshot?.playOrder).toEqual([0, 1]);
    });

    it("coalesces rapid queue mutations into one debounced write", async () => {
      const h = await readyHarness();
      fillStore(h);
      h.controller.notifyQueueChanged();
      h.controller.notifyQueueChanged();
      h.controller.notifyQueueChanged();
      expect(h.deps.savePlaybackStateAction).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
      const input = h.deps.savePlaybackStateAction.mock.calls[0]?.[0];
      expect(
        input?.queueSnapshot?.entries.map(
          (e: { providerTrackId: string }) => e.providerTrackId,
        ),
      ).toEqual([
        "a",
        "b",
      ]);
    });

    it("skips writes when the snapshot is unchanged", async () => {
      const h = await readyHarness();
      fillStore(h);
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
    });

    it("deletes the row when the queue empties (clear never returns)", async () => {
      const h = await readyHarness();
      fillStore(h);
      h.store.queue = [];
      h.store.playOrder = [];
      h.store.position = -1;
      h.store.currentTrack = null;
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.clearPlaybackStateAction).toHaveBeenCalledTimes(1);
      expect(h.deps.savePlaybackStateAction).not.toHaveBeenCalled();
    });

    it("does not save queue snapshots when anonymous", async () => {
      const h = reg(createHarness());
      await h.controller.initialize(null);
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.deps.savePlaybackStateAction).not.toHaveBeenCalled();
      expect(h.deps.clearPlaybackStateAction).not.toHaveBeenCalled();
    });
  });

  /**
   * The single write lane.
   *
   * Every writer persists the whole snapshot under one revision CAS, so two
   * concurrent writers race and the server drops the loser's payload. The
   * loser is not necessarily the newer write — it is whichever request
   * reached the database second — so a track checkpoint racing a queue write
   * could durably revert a queue the user had just extended.
   *
   * These tests pin the lane itself: at most one write in flight, and a
   * request made while the lane is busy is re-driven afterwards rather than
   * dropped.
   */
  describe("single write lane", () => {
    async function readyHarness() {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      vi.clearAllMocks();
      return h;
    }

    it("never has two writes in flight", async () => {
      const h = await readyHarness();
      h.store.queue = [makeTrack("a"), makeTrack("b")];
      h.store.playOrder = [0, 1];
      h.store.position = 0;
      h.store.currentTrack = h.store.queue[0];
      h.store.currentTime = 17;

      let inFlight = 0;
      let peak = 0;
      h.deps.savePlaybackStateAction.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { ok: true as const };
      });

      // Both writers, fired together: a track change and a queue change.
      h.controller.notifyTrackChanged(makeTrack("old"), 10);
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(1000);

      expect(peak, "two persistence writes were in flight at once").toBe(1);
    });

    it("re-drives a queue write that arrives while a checkpoint is in flight", async () => {
      const h = await readyHarness();
      h.store.queue = [makeTrack("a")];
      h.store.playOrder = [0];
      h.store.position = 0;
      h.store.currentTrack = h.store.queue[0];

      const gate = deferred<{ ok: true }>();
      h.deps.savePlaybackStateAction
        .mockImplementationOnce(async () => gate.promise)
        .mockImplementation(async () => ({ ok: true as const }));

      // Checkpoint first, with a one-entry queue, and hold it open.
      h.controller.notifyTrackChanged(makeTrack("old"), 10);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      // The user extends the queue while that write is still in flight.
      h.store.queue = [makeTrack("a"), makeTrack("b")];
      h.store.playOrder = [0, 1];
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      // The debounced write cannot compete, so it parks in the lane.
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      gate.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(1000);

      // The parked write ran, and the LAST payload to reach the row is the
      // two-entry queue. This is the assertion the revert violated: the
      // durable state must never end up older than the newest request.
      const calls = h.deps.savePlaybackStateAction.mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(
        last?.queueSnapshot?.entries.map(
          (e: { providerTrackId: string }) => e.providerTrackId,
        ),
        "the newest queue did not win the lane",
      ).toEqual(["a", "b"]);
    });

    it("re-drives a checkpoint that arrives while a queue write is in flight", async () => {
      const h = await readyHarness();
      h.store.queue = [makeTrack("a")];
      h.store.playOrder = [0];
      h.store.position = 0;
      h.store.currentTrack = h.store.queue[0];

      const gate = deferred<{ ok: true }>();
      h.deps.savePlaybackStateAction
        .mockImplementationOnce(async () => gate.promise)
        .mockImplementation(async () => ({ ok: true as const }));

      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      h.controller.notifyPaused(h.store.queue[0], 42);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      gate.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(1000);

      // The parked checkpoint was not dropped: its operation snapshot - the
      // position the user paused at - survives the lane.
      const calls = h.deps.savePlaybackStateAction.mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last?.position, "the parked checkpoint was lost").toBe(42);
    });

    it("retries a checkpoint once after losing a revision CAS", async () => {
      const h = await readyHarness();
      h.store.queue = [makeTrack("a")];
      h.store.playOrder = [0];
      h.store.position = 0;
      h.store.currentTrack = h.store.queue[0];

      h.deps.savePlaybackStateAction
        .mockImplementationOnce(async () => ({ ok: true as const, stale: true }))
        .mockImplementation(async () => ({ ok: true as const }));

      h.controller.notifyPaused(h.store.queue[0], 33);
      await vi.advanceTimersByTimeAsync(1000);

      // Stale means a foreign writer won; the cursor this checkpoint carries
      // is not reconstructible, so it is re-driven rather than discarded.
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(2);
      expect(h.deps.savePlaybackStateAction.mock.calls[1]?.[0]?.position).toBe(33);
    });

    it("gives up after one CAS retry rather than spinning", async () => {
      const h = await readyHarness();
      h.store.queue = [makeTrack("a")];
      h.store.playOrder = [0];
      h.store.position = 0;
      h.store.currentTrack = h.store.queue[0];

      h.deps.savePlaybackStateAction.mockImplementation(async () => ({
        ok: true as const,
        stale: true,
      }));

      h.controller.notifyPaused(h.store.queue[0], 33);
      await vi.advanceTimersByTimeAsync(5000);

      // Bounded: a tab that is not the live session must not turn a lost
      // cursor update into an unbounded request loop.
      expect(h.deps.savePlaybackStateAction.mock.calls.length).toBeLessThanOrEqual(3);
    });
  });

  /**
   * The offline isolation invariant, on the persistence path specifically.
   *
   * The queue SNAPSHOT already refuses to serialize a local track. The legacy
   * `provider`/`providerTrackId` columns of the same row did not, and a local
   * track's id is its folder-relative path - so playing a local file wrote the
   * user's local folder structure into the durable server-side session, on
   * every checkpoint. Asserted on the arguments that would actually reach the
   * server, not on internal state.
   */
  describe("offline isolation", () => {
    const localTrack = makeTrack("Album/Song.mp3", {
      provider: "local",
      id: "Album/Song.mp3",
      providerTrackId: "Album/Song.mp3",
    });

    async function readyHarness() {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      vi.clearAllMocks();
      return h;
    }

    it("never persists a local track's path in a checkpoint", async () => {
      const h = await readyHarness();
      h.store.queue = [localTrack];
      h.store.playOrder = [0];
      h.store.position = 0;
      h.store.currentTrack = localTrack;

      h.controller.notifyPaused(localTrack, 12);
      await vi.advanceTimersByTimeAsync(0);

      for (const call of h.deps.savePlaybackStateAction.mock.calls) {
        const input = call[0];
        expect(input?.provider, "a local provider reached the server").not.toBe(
          "local",
        );
        expect(JSON.stringify(input)).not.toContain("Album/Song.mp3");
      }
    });

    it("never persists a local track's path in the queue write", async () => {
      const h = await readyHarness();
      h.store.queue = [localTrack];
      h.store.playOrder = [0];
      h.store.position = 0;
      h.store.currentTrack = localTrack;

      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);

      for (const call of h.deps.savePlaybackStateAction.mock.calls) {
        expect(JSON.stringify(call[0])).not.toContain("Album/Song.mp3");
      }
    });

    it("still persists a provider-backed cursor when a local track is playing", async () => {
      // The guard must not throw away the whole write: with a provider track
      // in the queue the row should still carry it, because dropping the
      // session write would lose the user's queue.
      const h = await readyHarness();
      const remote = makeTrack("yt-1");
      h.store.queue = [localTrack, remote];
      h.store.playOrder = [0, 1];
      h.store.position = 1;
      h.store.currentTrack = localTrack;

      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);

      const input = h.deps.savePlaybackStateAction.mock.calls.at(-1)?.[0];
      expect(input?.provider).toBe("mock");
      expect(input?.providerTrackId).toBe("yt-1");
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

  describe("isSeekJump", () => {
    it("detects large discontinuities as seeks", () => {
      expect(isSeekJump(10, 92)).toBe(true);
      expect(isSeekJump(92, 10)).toBe(true);
    });

    it("ignores natural timeupdate progress", () => {
      expect(isSeekJump(10, 10.2)).toBe(false);
      expect(isSeekJump(10, 11.4)).toBe(false);
    });

    it("rejects non-finite inputs", () => {
      expect(isSeekJump(Number.NaN, 10)).toBe(false);
      expect(isSeekJump(10, Number.POSITIVE_INFINITY)).toBe(false);
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

  describe("Phase 43 session persistence", () => {
    async function readyHarness() {
      const h = reg(createHarness());
      await h.controller.initialize("user-1");
      vi.clearAllMocks();
      return h;
    }

    function fillQueue(h: ReturnType<typeof createHarness>) {
      h.store.queue = [makeTrack("a"), makeTrack("b")];
      h.store.playOrder = [0, 1];
      h.store.position = 0;
      h.store.currentTrack = h.store.queue[0];
      h.store.currentTime = 20;
    }

    it("restores persisted volume and mute into live player state", async () => {
      const h = reg(createHarness());
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({
          queueSnapshot: {
            version: 2,
            entries: [
              {
                provider: "mock",
                providerTrackId: "t-a",
                title: "Track A",
                artistId: "a1",
                artistName: "Artist",
              },
            ],
            playOrder: [0],
            position: 0,
            mediaPosition: 20,
            shuffle: false,
            repeat: "off" as const,
            volume: 0.75,
            muted: true,
            savedAt: 1_700_000_000_000,
          },
        }),
      });
      h.deps.resolveTrack.mockResolvedValue(makeTrack("t-a"));

      await h.controller.initialize("user-1");

      const restored = h.deps.applyQueueRestore.mock.calls[0]?.[0];
      expect(restored?.volume).toBe(0.75);
      expect(restored?.muted).toBe(true);
      expect(h.store.volume).toBe(0.75);
      expect(h.store.muted).toBe(true);
    });

    it("persists a volume or mute change through the existing debounced write", async () => {
      const h = await readyHarness();
      fillQueue(h);
      h.store.volume = 0.25;
      h.controller.notifyPreferencesChanged();
      h.controller.notifyPreferencesChanged();
      await vi.advanceTimersByTimeAsync(600);

      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
      const written = h.deps.savePlaybackStateAction.mock.calls[0]?.[0];
      expect(written?.queueSnapshot?.volume).toBe(0.25);
    });

    it("migrates a persisted v1 session and keeps the queue operable", async () => {
      const h = reg(createHarness());
      h.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({
          queueSnapshot: {
            version: 1,
            entries: [
              {
                provider: "mock",
                providerTrackId: "t-a",
                title: "Track A",
                artistId: "a1",
                artistName: "Artist",
              },
              {
                provider: "mock",
                providerTrackId: "t-b",
                title: "Track B",
                artistId: "a1",
                artistName: "Artist",
              },
            ],
            playOrder: [1, 0],
            position: 1,
            mediaPosition: 55,
            shuffle: true,
            repeat: "all",
          },
        }),
      });
      h.deps.resolveTrack.mockResolvedValue(makeTrack("t-b"));

      await h.controller.initialize("user-1");

      // Queue, order, cursor, and position all survive the upgrade.
      const restored = h.deps.applyQueueRestore.mock.calls[0]?.[0];
      expect(restored?.tracks.map((t: Track) => t.providerTrackId)).toEqual([
        "t-a",
        "t-b",
      ]);
      expect(restored?.playOrder).toEqual([1, 0]);
      expect(restored?.position).toBe(1);
      expect(restored?.mediaPosition).toBe(55);
      expect(restored?.shuffle).toBe(true);
      expect(restored?.repeat).toBe("all");
      // The legacy single-track path must not also fire.
      expect(h.deps.applyRestore).not.toHaveBeenCalled();
    });

    it("does not rewrite an unchanged session just because time passed", async () => {
      const h = await readyHarness();
      fillQueue(h);
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      // Same session, later clock: a page-hide flush must stay a no-op.
      await vi.advanceTimersByTimeAsync(5_000);
      h.controller.flushQueueSnapshot();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
    });

    it("re-arms a page-hide flush that arrives while a write is in flight", async () => {
      const h = await readyHarness();
      fillQueue(h);
      const gate = deferred<{ ok: boolean }>();
      h.deps.savePlaybackStateAction.mockReturnValue(gate.promise);

      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      // The user mutates the queue, then closes the tab mid-write. The
      // flush must not be dropped: it has to re-run once the write lands.
      h.store.currentTime = 90;
      h.controller.flushQueueSnapshot();
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      gate.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(2);
      const latest = h.deps.savePlaybackStateAction.mock.calls[1]?.[0];
      expect(latest?.queueSnapshot?.mediaPosition).toBe(90);
    });

    it("re-arms a debounced queue change that lands while a write is in flight", async () => {
      // Regression: a queue mutation whose debounced write starts while a
      // previous write is still in flight used to be dropped outright. The
      // debounce had already disarmed its timer, so nothing re-armed it and
      // the user's newest queue was silently never persisted — recoverable
      // only if the user later hid or closed the page. A server round trip
      // outlasting the 500ms debounce is ordinary on a slow connection, and
      // queue changes arrive continuously while a track plays.
      const h = await readyHarness();
      fillQueue(h);
      const gate = deferred<{ ok: boolean }>();
      h.deps.savePlaybackStateAction.mockReturnValue(gate.promise);

      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      // The user reorders while write #1 is still open. The debounce fires
      // and the second write cannot start, so it must be queued, not lost.
      h.store.currentTime = 90;
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);
      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);

      gate.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(h.deps.savePlaybackStateAction).toHaveBeenCalledTimes(2);
      // The retry must rebuild from current state, not replay write #1.
      const latest = h.deps.savePlaybackStateAction.mock.calls[1]?.[0];
      expect(latest?.queueSnapshot?.mediaPosition).toBe(90);
    });

    it("persists the resumed position of a track the user navigated to", async () => {
      const h = await readyHarness();
      fillQueue(h);
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);

      // next() moved the cursor to Track B at 00:00.
      h.store.position = 1;
      h.store.currentTrack = h.store.queue[1];
      h.store.currentTime = 0;
      h.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);

      const latest = h.deps.savePlaybackStateAction.mock.calls.at(-1)?.[0];
      expect(latest?.queueSnapshot?.position).toBe(1);
      expect(latest?.queueSnapshot?.mediaPosition).toBe(0);
      expect(latest?.providerTrackId).toBe("b");
    });
  });

  /**
   * J14 — restored position, verified deterministically from the
   * persisted snapshot rather than from a playing media element.
   *
   * The round trip is the real production path end to end: live store →
   * `serializeQueueSnapshot` → the JSON actually written to the JSONB
   * column → `validateQueueSnapshot` on read → `initialize()` restore.
   * Nothing here depends on audio progression, so the restored position
   * is a pure function of what was persisted.
   */
  describe("J14 restored position (snapshot round trip)", () => {
    /**
     * Acceptance tolerance for a restored position. The contract is
     * "resume at the persisted position", not "resume at an identical
     * millisecond": restore normalizes the value (floor, non-negative
     * clamp, clamp to a known duration) and a real media element may
     * advance before the user hears anything. The assertion is therefore
     * a bounded neighbourhood — persisted 90s accepts 87s–93s — so it
     * proves meaningful proximity instead of pinning a rounding
     * artifact. Live progression of a real stream stays the
     * responsibility of the opt-in live playback suite.
     */
    const RESTORE_POSITION_TOLERANCE_S = 3;

    /** Where the user stopped, and the position restore must honour. */
    const PERSISTED_POSITION_S = 90;

    it("restores the persisted position, cursor occurrence, and queue order", async () => {
      // --- Persist: a shuffled session with a repeated track occurrence.
      const writer = reg(createHarness());
      await writer.controller.initialize("user-1");
      vi.clearAllMocks();

      // Track "a" is queued twice on purpose: the snapshot must keep both
      // slots, and the cursor must land on the occurrence the user was
      // actually listening to rather than collapsing onto the first one.
      writer.store.queue = [makeTrack("a"), makeTrack("b"), makeTrack("a")];
      writer.store.playOrder = [1, 2, 0];
      writer.store.position = 1;
      writer.store.currentTrack = writer.store.queue[2] as Track;
      writer.store.currentTime = PERSISTED_POSITION_S;
      writer.store.shuffle = true;
      writer.store.repeat = "all";
      writer.store.volume = 0.5;
      writer.store.muted = true;

      writer.controller.notifyQueueChanged();
      await vi.advanceTimersByTimeAsync(600);

      expect(writer.deps.savePlaybackStateAction).toHaveBeenCalledTimes(1);
      const written = writer.deps.savePlaybackStateAction.mock.calls[0]?.[0];
      const persisted = written?.queueSnapshot;
      expect(persisted?.mediaPosition).toBe(PERSISTED_POSITION_S);

      // No temporary playback URL ever reaches the column: the live
      // tracks carried a streamUrl, and the persisted JSON must not.
      const persistedRaw = JSON.stringify(persisted);
      for (const forbidden of [
        "streamUrl",
        "previewUrl",
        "mimeType",
        "expiresAt",
        "bitrate",
        "googlevideo",
        "https://example.com/a.mp3",
      ]) {
        expect(persistedRaw).not.toContain(forbidden);
      }

      // --- Restore: read the row back exactly as the server returns it
      // (JSONB round trip) into a fresh controller, so nothing can be
      // satisfied by an in-memory carry-over.
      const reader = reg(createHarness());
      reader.deps.getPlaybackStateAction.mockResolvedValue({
        ok: true,
        state: makePayload({
          provider: "mock",
          providerTrackId: "a",
          position: PERSISTED_POSITION_S,
          revision: 1,
          queueSnapshot: JSON.parse(persistedRaw) as unknown,
        }),
      });
      reader.deps.resolveTrack.mockImplementation(
        async (provider: string, providerTrackId: string) =>
          provider === "mock" && providerTrackId === "a"
            ? makeTrack("a", { title: "Track a (provider fresh)" })
            : null,
      );

      await reader.controller.initialize("user-1");

      // The restore path really ran: the versioned snapshot was applied,
      // and neither the legacy single-track path nor the discard path
      // was taken as a fallback.
      expect(reader.deps.applyQueueRestore).toHaveBeenCalledTimes(1);
      expect(reader.deps.applyRestore).not.toHaveBeenCalled();
      expect(reader.deps.clearPlaybackStateAction).not.toHaveBeenCalled();
      expect(reader.deps.setInitState).toHaveBeenCalledWith("ready");

      // Only the cursor entry is re-resolved; queued entries stay
      // identity-only until played.
      expect(reader.deps.resolveTrack).toHaveBeenCalledTimes(1);
      expect(reader.deps.resolveTrack).toHaveBeenCalledWith("mock", "a");

      const restored = reader.deps.applyQueueRestore.mock.calls[0]?.[0];
      expect(restored).toBeDefined();

      // Queue contents and logical order survive intact, both
      // occurrences included (no dedup on the way in or out).
      expect(restored?.tracks.map((t: Track) => t.providerTrackId)).toEqual([
        "a",
        "b",
        "a",
      ]);
      expect(restored?.playOrder).toEqual([1, 2, 0]);
      expect(restored?.position).toBe(1);

      // The cursor points at occurrence slot 2, not the first "a" at
      // slot 0 — this is what makes the restore positional rather than
      // merely "the right track name".
      expect(restored?.playOrder[restored?.position as number]).toBe(2);

      // The current track is provider-fresh, while the queued copy of
      // the same track still carries the persisted display metadata.
      expect(restored?.currentTrack?.title).toBe("Track a (provider fresh)");
      expect(
        restored?.tracks[2]?.title,
        "queued occurrences stay identity-only",
      ).toBe("Track a");

      // The restored position lands meaningfully near the persisted
      // value — within tolerance, not millisecond-exact.
      const persistedPosition = (
        JSON.parse(persistedRaw) as { mediaPosition: number }
      ).mediaPosition;
      expect(
        Math.abs((restored?.mediaPosition as number) - persistedPosition),
      ).toBeLessThanOrEqual(RESTORE_POSITION_TOLERANCE_S);
      // And the tolerance is not wide enough to hide a restore to zero.
      expect(restored?.mediaPosition).toBeGreaterThan(
        persistedPosition - RESTORE_POSITION_TOLERANCE_S - 1,
      );
      expect(reader.store.currentTime).toBe(restored?.mediaPosition);
    });
  });
});
