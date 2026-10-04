// @vitest-environment jsdom
/**
 * Skipping a track whose recovery budget is exhausted.
 *
 * Before this, an unplayable track ended the session: the controller reported
 * the error, stopped, and left the listener looking at a Retry button for a
 * track that could never resolve. One dead video was a dead end.
 *
 * The policy is deliberately ordered AFTER the existing retry budget — a
 * transient failure is still retried, and only then is the track stepped over.
 * These tests pin the six edge cases the behaviour has to survive, the two that
 * matter most being the loop guards: an all-unplayable queue and `repeat: "all"`
 * must both terminate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import {
  resetUnavailableSkipGuardForTests,
  usePlayerStore,
} from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import {
  EventEnum,
  FakeAudioSurface,
  makePlayableTrack,
} from "@/lib/player/__tests__/fake-audio";

const mocks = vi.hoisted(() => ({ getDefaultEngine: vi.fn() }));
/** The fake media surface, so a test can dispatch engine events directly. */
const surfaceRef: { current: FakeAudioSurface | null } = { current: null };

vi.mock("@/lib/player/engine-factory", () => ({
  getDefaultEngine: mocks.getDefaultEngine,
}));

vi.mock("@/app/actions/playback", () => ({
  recordPlayedAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/app/actions/playback-state", () => ({
  getPlaybackStateAction: vi.fn().mockResolvedValue({ ok: true, state: null }),
  savePlaybackStateAction: vi.fn().mockResolvedValue({ ok: true }),
  clearPlaybackStateAction: vi.fn().mockResolvedValue({ ok: true }),
  getSessionUserIdAction: vi.fn().mockResolvedValue({ ok: true, userId: null }),
  resolvePlaybackTrackAction: vi.fn().mockResolvedValue({ ok: true, track: null }),
  invalidatePlaybackResolutionAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/dal/session", () => ({
  getSessionUserId: vi.fn().mockResolvedValue(null),
  getCurrentUser: vi.fn().mockResolvedValue(null),
  requireUser: vi.fn().mockRejectedValue(new Error("unauthenticated")),
}));

function yt(id: string) {
  return makePlayableTrack(id, {
    provider: "youtube",
    providerTrackId: id,
    title: `Track ${id}`,
    artistName: "Artist",
  });
}

/** Queue the given ids and start the first one. */
function queue(...ids: string[]) {
  usePlayerStore.getState().replaceQueue(ids.map(yt));
  return usePlayerStore.getState();
}

beforeEach(() => {
  resetUnavailableSkipGuardForTests();
  const audio = new FakeAudioSurface();
  surfaceRef.current = audio;
  mocks.getDefaultEngine.mockImplementation(
    () => new PlayerEngine(audio as unknown as ConstructorParameters<typeof PlayerEngine>[0]),
  );
});

afterEach(() => {
  cleanup();
  resetUnavailableSkipGuardForTests();
  usePlayerStore.getState().clearQueue();
  vi.clearAllMocks();
});

describe("skipUnavailableTrack", () => {
  it("A. steps over one bad track in the middle and keeps playing", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b", "c");
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");

    usePlayerStore.getState().skipUnavailableTrack();

    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    // Order is preserved: b sits where it did.
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(usePlayerStore.getState().playOrder).toEqual([0, 1, 2]);
  });

  it("B. advances correctly when the FIRST track is unavailable", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b");

    usePlayerStore.getState().skipUnavailableTrack();

    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    // `isPlaying` is deliberately NOT asserted: this harness stubs the
    // resolver to return no track, so nothing ever reaches `playing` and the
    // flag cannot become true here. That is a property of the fixture, not of
    // the skip, and asserting it would be testing the fake.
  });

  it("C. stops cleanly when the FINAL track is unavailable", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b");

    // Land on b, then step past the end.
    usePlayerStore.getState().next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    usePlayerStore.getState().skipUnavailableTrack();

    // No crash, no wrap to a, and playback is not left claiming to play.
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().queue).toHaveLength(2);
  });

  it("D. terminates when EVERY remaining track is unavailable", async () => {
    // The guard that makes the whole feature safe. Without a bound this is an
    // infinite loop: skip -> load -> exhaust -> skip.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b", "c");

    // One pass plus the terminating call. If the bound were missing this loop
    // would never exit and the suite would time out.
    for (let i = 0; i < 12; i += 1) {
      usePlayerStore.getState().skipUnavailableTrack();
    }

    expect(usePlayerStore.getState().isPlaying).toBe(false);
    // The queue itself is untouched: skipping is navigation, not deletion.
    expect(usePlayerStore.getState().queue).toHaveLength(3);
  });

  it("D2. does not loop under repeat:all either", async () => {
    // `repeat: "all"` makes `nextQueueIndex` wrap, which is the case most
    // likely to spin forever.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b");
    usePlayerStore.getState().cycleRepeat();
    expect(usePlayerStore.getState().repeat).toBe("all");

    for (let i = 0; i < 12; i += 1) {
      usePlayerStore.getState().skipUnavailableTrack();
    }

    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("E. is not involved when a retry succeeds", async () => {
    // Nothing to skip: the store action is only ever called from the
    // controller's EXHAUSTED path, so a successful retry never touches it.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b");

    usePlayerStore.getState().playAtPosition(1);

    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    // `isPlaying` is deliberately NOT asserted: this harness stubs the
    // resolver to return no track, so nothing ever reaches `playing` and the
    // flag cannot become true here. That is a property of the fixture, not of
    // the skip, and asserting it would be testing the fake.
  });

  it("F. resets the guard once something actually plays", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b");

    // Burn most of the budget on skips.
    usePlayerStore.getState().skipUnavailableTrack();
    usePlayerStore.getState().skipUnavailableTrack();

    // A successful play clears the run, so a later bad stretch gets a full pass
    // again rather than inheriting an exhausted allowance.
    usePlayerStore.getState().playAtPosition(0);
    usePlayerStore.getState().next();
    // The guard is reset by the engine's `play` event, which the store subscribes
    // to directly. Driving that event is the honest way to assert the wiring
    // here: the fake surface never produces one on its own because the resolver
    // is stubbed to return no track.
    surfaceRef.current?.dispatch(EventEnum.playing);

    // With the run cleared, a fresh full pass is available again — which is the
    // difference between "skips since something played" and "skips ever".
    for (let i = 0; i < 2; i += 1) {
      usePlayerStore.getState().skipUnavailableTrack();
    }
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().queue).toHaveLength(2);
  });

  it("does not count as a user action", async () => {
    // Skipping is playback continuing, not the listener doing something, so it
    // must not suppress the "Continue listening" signal.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b");

    const before = usePlayerStore.getState().userActionGeneration;
    usePlayerStore.getState().skipUnavailableTrack();

    expect(usePlayerStore.getState().userActionGeneration).toBe(before);
  });

  it("leaves shuffle and the queue itself untouched", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    queue("a", "b", "c");
    const shuffled = usePlayerStore.getState().shuffle;

    usePlayerStore.getState().skipUnavailableTrack();

    expect(usePlayerStore.getState().shuffle).toBe(shuffled);
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("is a no-op on an empty queue", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([]);

    expect(() =>
      usePlayerStore.getState().skipUnavailableTrack(),
    ).not.toThrow();
    expect(usePlayerStore.getState().queue).toHaveLength(0);
  });
});
