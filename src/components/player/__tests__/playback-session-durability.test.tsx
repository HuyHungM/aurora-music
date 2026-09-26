// @vitest-environment jsdom
/**
 * Playback-session durability across app exit (bugfix mission §52).
 *
 * These probes target the paths the existing controller suites do not
 * cover: queue REPLACE/clear/move persistence through the real store,
 * the visibilitychange lifecycle, corrupt/stale snapshot rejection,
 * post-restore live mutation, cross-user isolation, and write cadence.
 *
 * The controller is exercised through the real `PlayerHost` so the
 * subscription wiring under test is the shipping wiring, not a
 * reconstruction of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import {
  FakeAudioSurface,
  makePlayableTrack,
} from "@/lib/player/__tests__/fake-audio";
import {
  QUEUE_SNAPSHOT_VERSION,
  type PersistedQueueSnapshot,
} from "@/lib/player/queue-snapshot";
import { createPlaybackOwnership } from "@/lib/multi-tab/playback-ownership";
import type { Track } from "@/lib/domain";
import {
  isForeignPlaybackOwnerActive,
  setPlaybackOwnership,
} from "@/lib/multi-tab/instance";

const mocks = vi.hoisted(() => ({
  getDefaultEngine: vi.fn(),
  getPlaybackStateAction: vi.fn(),
  savePlaybackStateAction: vi.fn(),
  clearPlaybackStateAction: vi.fn(),
  getSessionUserIdAction: vi.fn(),
  resolvePlaybackTrackAction: vi.fn(),
}));

vi.mock("@/lib/player/engine-factory", () => ({
  getDefaultEngine: mocks.getDefaultEngine,
}));

vi.mock("@/app/actions/playback", () => ({
  recordPlayedAction: vi.fn().mockResolvedValue({ ok: true }),
}));

// The real resolver would attempt provider resolution and surface an
// unrelated "no playable stream" error; persistence behaviour must be
// judged without it. A well-formed source keeps the player healthy so any
// error observed belongs to persistence, not to resolution.
vi.mock("@/app/actions/playback-resolve", () => ({
  resolveAudioSourceAction: vi.fn().mockResolvedValue({
    ok: true,
    source: { url: "https://example.test/stream", mimeType: "audio/mp4" },
  }),
}));

vi.mock("@/app/actions/playback-state", () => ({
  getPlaybackStateAction: mocks.getPlaybackStateAction,
  savePlaybackStateAction: mocks.savePlaybackStateAction,
  clearPlaybackStateAction: mocks.clearPlaybackStateAction,
  getSessionUserIdAction: mocks.getSessionUserIdAction,
  resolvePlaybackTrackAction: mocks.resolvePlaybackTrackAction,
}));

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
    restoredTrackKey: null,
  });
}

function track(id: string) {
  return makePlayableTrack(id, { title: `Title ${id}` });
}

/** Minimal valid persisted snapshot for N titled tracks. */
function snapshotOf(ids: string[], overrides: Partial<PersistedQueueSnapshot> = {}) {
  return {
    version: QUEUE_SNAPSHOT_VERSION,
    entries: ids.map((id) => ({
      provider: "mock",
      providerTrackId: id,
      title: `Title ${id}`,
      artistId: `artist-${id}`,
      artistName: `Artist ${id}`,
    })),
    playOrder: ids.map((_, i) => i),
    position: 0,
    mediaPosition: 0,
    shuffle: false,
    repeat: "off" as const,
    volume: 1,
    muted: false,
    savedAt: Date.now(),
    ...overrides,
  };
}

/** The last snapshot handed to the save action, typed for assertions. */
function lastSavedSnapshot(): PersistedQueueSnapshot | undefined {
  const calls = mocks.savePlaybackStateAction.mock.calls;
  if (calls.length === 0) return undefined;
  return calls[calls.length - 1]?.[0]?.queueSnapshot as
    | PersistedQueueSnapshot
    | undefined;
}

async function mountAuthenticated() {
  render(<PlayerHost />);
  await waitFor(() =>
    expect(usePlayerStore.getState().persistenceInitState).toBe("ready"),
  );
}

/** Lets the 500 ms debounced queue-snapshot write land. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

/**
 * Waits for a write that is *expected* to happen. Never use this where a
 * correct implementation is supposed to issue no request (a cleared or
 * anonymous session): the wait would fail on correct behaviour.
 */
async function settleExpectingWrite() {
  await settle();
  await waitFor(() =>
    expect(mocks.savePlaybackStateAction).toHaveBeenCalled(),
  );
}

/** Restores nothing; the caller drives the live store. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("playback session durability across app exit", () => {
  beforeEach(() => {
    resetStore();
    setPlaybackOwnership(null);
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.getDefaultEngine.mockReturnValue(
      new PlayerEngine(new FakeAudioSurface()),
    );
    mocks.getPlaybackStateAction.mockResolvedValue({ ok: true, state: null });
    mocks.savePlaybackStateAction.mockResolvedValue({ ok: true });
    mocks.clearPlaybackStateAction.mockResolvedValue({ ok: true });
    mocks.getSessionUserIdAction.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mocks.resolvePlaybackTrackAction.mockResolvedValue({
      ok: true,
      track: null,
    });
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().bindEngine(null);
    vi.useRealTimers();
  });

  // ---------------------------------------------------------------- §11
  it("replaceQueue replaces the persisted session instead of merging it", async () => {
    await mountAuthenticated();
    usePlayerStore.getState().replaceQueue([track("a"), track("b")], {
      startIndex: 0,
    });
    await settleExpectingWrite();
    expect(lastSavedSnapshot()?.entries.map((e) => e.providerTrackId)).toEqual([
      "a",
      "b",
    ]);

    usePlayerStore
      .getState()
      .replaceQueue([track("z")], { startIndex: 0 });
    await settleExpectingWrite();

    // The newer session is authoritative: "a"/"b" are gone, not appended.
    expect(lastSavedSnapshot()?.entries.map((e) => e.providerTrackId)).toEqual([
      "z",
    ]);
  });

  // ---------------------------------------------------------------- §10
  it("clearing the queue deletes the persisted row so it never returns", async () => {
    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b")], { startIndex: 0 });
    await settleExpectingWrite();
    expect(mocks.savePlaybackStateAction).toHaveBeenCalled();

    usePlayerStore.getState().clearQueue();
    // A cleared queue deletes the row; it issues no snapshot write.
    await settle();

    expect(mocks.clearPlaybackStateAction).toHaveBeenCalled();
    // Nothing may re-persist a cleared queue afterwards.
    mocks.savePlaybackStateAction.mockClear();
    await settle();
    expect(mocks.savePlaybackStateAction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------- §49
  it("persists a reordered queue", async () => {
    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b"), track("c")], { startIndex: 0 });
    await settleExpectingWrite();
    expect(lastSavedSnapshot()?.playOrder).toEqual([0, 1, 2]);

    usePlayerStore.getState().moveQueueItem(0, "down");
    await settleExpectingWrite();

    const saved = lastSavedSnapshot();
    expect(saved?.playOrder).not.toEqual([0, 1, 2]);
    expect(
      saved?.playOrder.map((i) => saved.entries[i]?.providerTrackId),
    ).toEqual(["b", "a", "c"]);
  });

  it("persists removal from the queue", async () => {
    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b"), track("c")], { startIndex: 0 });
    await settleExpectingWrite();

    usePlayerStore.getState().removeFromQueue(1);
    await settleExpectingWrite();

    expect(
      lastSavedSnapshot()?.entries.map((e) => e.providerTrackId),
    ).toEqual(["a", "c"]);
  });

  // ---------------------------------------------------------------- §8
  it("flushes a pending queue write when the page is hidden", async () => {
    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b")], { startIndex: 0 });

    // Debounce has not fired yet: no write so far.
    expect(mocks.savePlaybackStateAction).not.toHaveBeenCalled();
    setVisibility("hidden");

    await waitFor(() =>
      expect(mocks.savePlaybackStateAction).toHaveBeenCalledTimes(1),
    );
  });

  it("writes nothing on a visibility change to visible, and a repeated hide does not re-write", async () => {
    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b")], { startIndex: 0 });

    // A `visible` transition must not flush on its own: the pending
    // debounce is left armed.
    setVisibility("visible");
    expect(mocks.savePlaybackStateAction).not.toHaveBeenCalled();

    // The debounce is what writes, and it writes exactly once.
    await settleExpectingWrite();
    expect(mocks.savePlaybackStateAction).toHaveBeenCalledTimes(1);

    // Hiding again with unchanged queue state is deduped by the content
    // key: a lifecycle event must never turn into a write storm.
    setVisibility("hidden");
    await settle();
    expect(mocks.savePlaybackStateAction).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------- §19
  it.each([
    ["a non-object", "not-a-snapshot"],
    ["a missing version", { entries: [], playOrder: [] }],
    [
      "a future version",
      { ...snapshotOf(["a"]), version: QUEUE_SNAPSHOT_VERSION + 1 },
    ],
    [
      "a negative version",
      { ...snapshotOf(["a"]), version: -1 },
    ],
    [
      "a missing queue",
      { ...snapshotOf(["a"]), entries: undefined },
    ],
    [
      "a dangling playOrder index",
      { ...snapshotOf(["a"]), playOrder: [7] },
    ],
    [
      "an out-of-range cursor",
      { ...snapshotOf(["a"]), position: 5 },
    ],
    [
      "a NaN position",
      { ...snapshotOf(["a"]), mediaPosition: Number.NaN },
    ],
    [
      "an Infinity position",
      { ...snapshotOf(["a"]), mediaPosition: Number.POSITIVE_INFINITY },
    ],
    [
      "a negative media position",
      { ...snapshotOf(["a"]), mediaPosition: -30 },
    ],
    [
      "an invalid repeat mode",
      { ...snapshotOf(["a"]), repeat: "sometimes" },
    ],
    [
      "a non-boolean shuffle",
      { ...snapshotOf(["a"]), shuffle: "yes" },
    ],
    [
      "a playback URL in an entry",
      {
        ...snapshotOf(["a"]),
        entries: [
          {
            provider: "mock",
            providerTrackId: "a",
            title: "Title a",
            artistId: "artist-a",
            artistName: "Artist a",
            streamUrl: "https://r.googlevideo.com/videoplayback?id=secret",
          },
        ],
      },
    ],
  ])("safely discards a corrupt snapshot (%s)", async (_label, bad) => {
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "a",
        position: 0,
        revision: 2,
        updatedAt: new Date().toISOString(),
        queueSnapshot: bad,
      },
    });

    await mountAuthenticated();

    // Never a stuck loading player, never a crash.
    expect(usePlayerStore.getState().persistenceInitState).toBe("ready");
    expect(usePlayerStore.getState().error).toBeNull();
  });

  // ---------------------------------------------------------------- §18
  it("keeps the queue when the current track no longer resolves", async () => {
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "a",
        position: 42,
        revision: 3,
        updatedAt: new Date().toISOString(),
        queueSnapshot: snapshotOf(["a", "b", "c"], { mediaPosition: 42 }),
      },
    });
    mocks.resolvePlaybackTrackAction.mockResolvedValue({
      ok: true,
      track: null,
    });

    await mountAuthenticated();

    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["a", "b", "c"]);
    // A position is never claimed for a track that could not be verified.
    expect(state.pendingRestorePosition).toBeNull();
    expect(state.persistenceInitState).toBe("ready");
  });

  // ---------------------------------------------------------------- §15
  it("restores a session without autoplay and resolves fresh on play", async () => {
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "a",
        position: 90,
        revision: 5,
        updatedAt: new Date().toISOString(),
        queueSnapshot: snapshotOf(["a", "b"], {
          mediaPosition: 90,
          position: 0,
          shuffle: true,
          repeat: "all",
        }),
      },
    });
    mocks.resolvePlaybackTrackAction.mockImplementation(
      async (_p: string, id: string) => ({ ok: true, track: track(id) }),
    );

    await mountAuthenticated();

    const state = usePlayerStore.getState();
    expect(state.isPlaying).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.currentTrack?.id).toBe("a");
    expect(state.shuffle).toBe(true);
    expect(state.repeat).toBe("all");
    expect(state.pendingRestorePosition).toBe(90);
    // No source was resolved for the restored cursor: resolution waits
    // for the user, so no temporary URL is ever held.
    expect(mocks.resolvePlaybackTrackAction).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------- §12
  it("restores the previous logical order under shuffle without reshuffling", async () => {
    const saved = snapshotOf(["a", "b", "c", "d"], {
      shuffle: true,
      playOrder: [2, 0, 3, 1],
      position: 1,
    });
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "a",
        position: 0,
        revision: 6,
        updatedAt: new Date().toISOString(),
        queueSnapshot: saved,
      },
    });
    mocks.resolvePlaybackTrackAction.mockImplementation(
      async (_p: string, id: string) => ({ ok: true, track: track(id) }),
    );

    await mountAuthenticated();

    const state = usePlayerStore.getState();
    // `queue` keeps insertion order; `playOrder` is the permutation.
    expect(state.queue.map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
    // The saved logical order is restored verbatim, never reshuffled.
    expect(state.playOrder).toEqual([2, 0, 3, 1]);
    expect(state.shuffle).toBe(true);
    expect(
      state.playOrder.map((i) => state.queue[i]?.id),
    ).toEqual(["c", "a", "d", "b"]);
    // The cursor points at the SAME occurrence that was persisted:
    // playOrder[position] === playOrder[1] === 0 => queue[0] === "a".
    expect(state.position).toBe(1);
    expect(state.currentTrack?.id).toBe("a");
  });

  // ---------------------------------------------------------------- §49
  it("a restored session transitions into normal live queue behaviour", async () => {
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "a",
        position: 0,
        revision: 7,
        updatedAt: new Date().toISOString(),
        queueSnapshot: snapshotOf(["a", "b", "c"]),
      },
    });
    mocks.resolvePlaybackTrackAction.mockImplementation(
      async (_p: string, id: string) => ({ ok: true, track: track(id) }),
    );

    await mountAuthenticated();
    mocks.savePlaybackStateAction.mockClear();

    // Mutating a restored queue must write normally, with no special case.
    usePlayerStore.getState().addToQueue(track("x"));
    await settleExpectingWrite();
    expect(
      lastSavedSnapshot()?.entries.map((e) => e.providerTrackId),
    ).toEqual(["a", "b", "c", "x"]);

    usePlayerStore.getState().toggleShuffle();
    await settleExpectingWrite();
    expect(typeof lastSavedSnapshot()?.shuffle).toBe("boolean");
  });

  // ---------------------------------------------------------------- §48
  it("next advances from the restored cursor", async () => {
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "a",
        position: 0,
        revision: 8,
        updatedAt: new Date().toISOString(),
        queueSnapshot: snapshotOf(["a", "b", "c"]),
      },
    });
    mocks.resolvePlaybackTrackAction.mockImplementation(
      async (_p: string, id: string) => ({ ok: true, track: track(id) }),
    );

    await mountAuthenticated();
    usePlayerStore.getState().next();

    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    expect(usePlayerStore.getState().position).toBe(1);
  });

  // ---------------------------------------------------------------- §21
  it("never hands one user's persisted session to another", async () => {
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "user-a-secret",
        position: 12,
        revision: 4,
        updatedAt: new Date().toISOString(),
      },
    });
    mocks.resolvePlaybackTrackAction.mockImplementation(
      async (_p: string, id: string) => ({ ok: true, track: track(id) }),
    );

    await mountAuthenticated();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("user-a-secret");

    // A second, independent controller bound to a different account.
    cleanup();
    resetStore();
    vi.clearAllMocks();
    mocks.getDefaultEngine.mockReturnValue(
      new PlayerEngine(new FakeAudioSurface()),
    );
    mocks.savePlaybackStateAction.mockResolvedValue({ ok: true });
    mocks.clearPlaybackStateAction.mockResolvedValue({ ok: true });
    mocks.getSessionUserIdAction.mockResolvedValue({ ok: true, userId: "user-2" });
    mocks.resolvePlaybackTrackAction.mockResolvedValue({ ok: true, track: null });
    // user-2 has no session of their own.
    mocks.getPlaybackStateAction.mockResolvedValue({ ok: true, state: null });

    await mountAuthenticated();

    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(usePlayerStore.getState().queue).toEqual([]);
  });

  // ---------------------------------------------------------------- §22
  it("an anonymous session writes nothing at all", async () => {
    mocks.getSessionUserIdAction.mockResolvedValue({ ok: true, userId: null });
    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b")], { startIndex: 0 });
    setVisibility("hidden");
    window.dispatchEvent(new Event("pagehide"));
    // An anonymous session issues no request of any kind.
    await settle();

    expect(mocks.savePlaybackStateAction).not.toHaveBeenCalled();
    expect(mocks.clearPlaybackStateAction).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------- §32
  it("does not write per timeupdate; the queue is still saved", async () => {
    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b")], { startIndex: 0 });
    await settleExpectingWrite();
    const baseline = mocks.savePlaybackStateAction.mock.calls.length;

    // Simulate sustained playback progress well past the debounce.
    for (let i = 1; i <= 40; i += 1) {
      usePlayerStore.setState({ currentTime: i * 0.25 });
    }
    await new Promise((resolve) => setTimeout(resolve, 700));

    // Sub-threshold progress (0.25 s steps) must not each cost a request.
    expect(mocks.savePlaybackStateAction.mock.calls.length).toBe(baseline);
  });

  // ---------------------------------------------------------------- §34
  it("a failing save never breaks playback or the player state", async () => {
    mocks.savePlaybackStateAction.mockRejectedValue(new Error("network down"));
    await mountAuthenticated();

    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b")], { startIndex: 0 });
    // A rejected save must not stop the debounce pipeline or the player.
    await settle();
    setVisibility("hidden");
    await settle();

    const state = usePlayerStore.getState();
    // The player keeps its queue, cursor and identity: persistence is
    // strictly non-fatal to playback.
    expect(state.queue.map((t) => t.id)).toEqual(["a", "b"]);
    expect(state.currentTrack?.id).toBe("a");
    expect(state.position).toBe(0);
    expect(state.persistenceInitState).toBe("ready");
    // The failure was swallowed by the controller, not surfaced as a
    // player error: no store error mentions persistence.
    expect(state.error?.message ?? "").not.toMatch(/persist|save|network/i);
    // And the controller stays live: it keeps attempting writes.
    expect(mocks.savePlaybackStateAction.mock.calls.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------- §35
  it("a failed restore still yields a ready, usable player", async () => {
    mocks.getPlaybackStateAction.mockRejectedValue(new Error("offline"));
    await mountAuthenticated();

    const state = usePlayerStore.getState();
    expect(state.persistenceInitState).toBe("ready");
    expect(state.isLoading).toBe(false);

    // And the player is still usable afterwards.
    usePlayerStore
      .getState()
      .replaceQueue([track("a")], { startIndex: 0 });
    expect(usePlayerStore.getState().queue).toHaveLength(1);
  });

  // ---------------------------------------------------------------- §10/§11
  it("a queue played immediately after a clear is still persisted", async () => {
    // Hold the clear in flight so the new queue's write overlaps it.
    let releaseClear!: () => void;
    const clearGate = new Promise<void>((resolve) => {
      releaseClear = resolve;
    });
    mocks.clearPlaybackStateAction.mockImplementation(async () => {
      await clearGate;
      return { ok: true as const };
    });

    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b")], { startIndex: 0 });
    await settleExpectingWrite();

    usePlayerStore.getState().clearQueue();
    // The clear request is now in flight. The user immediately starts a
    // new queue, whose debounced write lands while the delete is pending.
    await settle();
    usePlayerStore
      .getState()
      .replaceQueue([track("n1"), track("n2")], { startIndex: 0 });
    await settleExpectingWrite();

    releaseClear();
    await settle();

    // The newest session must win: the user cleared, then played. The
    // persisted row must end up describing the new queue, not deleted.
    const saves = mocks.savePlaybackStateAction.mock.calls;
    const lastWrite = saves[saves.length - 1]?.[0]?.queueSnapshot as
      | { entries: Array<{ providerTrackId: string }> }
      | undefined;
    expect(lastWrite?.entries.map((e) => e.providerTrackId)).toEqual([
      "n1",
      "n2",
    ]);
    // The delete must not be the last operation on the row.
    expect(mocks.clearPlaybackStateAction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.savePlaybackStateAction.mock.invocationCallOrder[
        mocks.savePlaybackStateAction.mock.invocationCallOrder.length - 1
      ] as number,
    );
  });

  // ---------------------------------------------------------------- §23
  it("a tab that yielded to a live foreign owner writes nothing", async () => {
    await mountAuthenticated();
    // Injected AFTER mount: `PlaybackOwnershipHost` registers its own
    // machine on mount, so anything set before render would be replaced.
    const foreign = createPlaybackOwnership({ tabId: "tab-a", now: () => Date.now() });
    const self = createPlaybackOwnership({ tabId: "tab-b", now: () => Date.now() });
    self.receive(foreign.claim(), Date.now());
    setPlaybackOwnership(self);
    expect(isForeignPlaybackOwnerActive()).toBe(true);

    try {
      usePlayerStore
        .getState()
        .replaceQueue([track("stale")], { startIndex: 0 });
      await settle();
      // Neither the debounce nor a lifecycle flush may write.
      setVisibility("hidden");
      window.dispatchEvent(new Event("pagehide"));
      await settle();

      expect(mocks.savePlaybackStateAction).not.toHaveBeenCalled();
      expect(mocks.clearPlaybackStateAction).not.toHaveBeenCalled();
      // The local player is untouched: only persistence is withheld.
      expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual([
        "stale",
      ]);
    } finally {
      setPlaybackOwnership(null);
    }
  });

  it("resumes writing as soon as the foreign owner releases", async () => {
    await mountAuthenticated();
    const foreign = createPlaybackOwnership({ tabId: "tab-a", now: () => Date.now() });
    const self = createPlaybackOwnership({ tabId: "tab-b", now: () => Date.now() });
    self.receive(foreign.claim(), Date.now());
    setPlaybackOwnership(self);

    try {
      usePlayerStore.getState().replaceQueue([track("x")], { startIndex: 0 });
      await settle();
      expect(mocks.savePlaybackStateAction).not.toHaveBeenCalled();

      // The owner stops playing and releases the claim.
      self.receive(foreign.release(), Date.now());
      expect(isForeignPlaybackOwnerActive()).toBe(false);

      usePlayerStore.getState().addToQueue(track("y"));
      await settleExpectingWrite();
      expect(
        lastSavedSnapshot()?.entries.map((e) => e.providerTrackId),
      ).toEqual(["x", "y"]);
    } finally {
      setPlaybackOwnership(null);
    }
  });

  it("persists normally in the single-tab case (no foreign owner)", async () => {
    await mountAuthenticated();
    usePlayerStore
      .getState()
      .replaceQueue([track("a"), track("b")], { startIndex: 0 });
    await settleExpectingWrite();
    expect(
      lastSavedSnapshot()?.entries.map((e) => e.providerTrackId),
    ).toEqual(["a", "b"]);
  });

  it("persists normally in the tab that owns playback", async () => {
    await mountAuthenticated();
    const self = createPlaybackOwnership({ tabId: "tab-a", now: () => Date.now() });
    const rival = createPlaybackOwnership({ tabId: "tab-b", now: () => Date.now() });
    rival.receive(self.claim(), Date.now());
    setPlaybackOwnership(self);
    // The owner is the live session and must keep writing.
    expect(isForeignPlaybackOwnerActive()).toBe(false);

    try {
      usePlayerStore
        .getState()
        .replaceQueue([track("live")], { startIndex: 0 });
      await settleExpectingWrite();
      expect(
        lastSavedSnapshot()?.entries.map((e) => e.providerTrackId),
      ).toEqual(["live"]);
    } finally {
      setPlaybackOwnership(null);
    }
  });

  // ---------------------------------------------------------------- §17
  it("never sends a playback URL to the persistence layer", async () => {
    await mountAuthenticated();
    // Carries a merged source ref, which IS persisted, plus a stream URL,
    // which must never be.
    const withSource: Track = {
      ...makePlayableTrack("a", { title: "Title a" }),
      metadata: { sources: [{ source: "yt", id: "a" }] },
    };
    usePlayerStore.getState().replaceQueue([withSource], { startIndex: 0 });
    await settleExpectingWrite();

    const raw = JSON.stringify(
      mocks.savePlaybackStateAction.mock.calls.at(-1)?.[0] ?? {},
    );
    expect(raw).not.toMatch(/googlevideo|videoplayback|expiresAt|streamUrl/);
  });
});
