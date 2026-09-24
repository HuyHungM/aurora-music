// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { EventEnum, FakeAudioSurface } from "@/lib/player/__tests__/fake-audio";
import type { Track } from "@/lib/domain";

const mocks = vi.hoisted(() => ({
  getDefaultEngine: vi.fn(),
  resolveAudioSourceAction: vi.fn(),
}));

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
}));

vi.mock("@/app/actions/playback-resolve", () => ({
  resolveAudioSourceAction: mocks.resolveAudioSourceAction,
}));

function youtubeTrack(id: string, title: string): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title,
    artistId: "UC1",
    artistName: "Host Artist",
  };
}

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
  });
}

const bar = () => within(screen.getByRole("region", { name: "Player bar" }));

describe("PlayerHost recovery integration", () => {
  let surface: FakeAudioSurface;

  beforeEach(() => {
    resetStore();
    surface = new FakeAudioSurface();
    mocks.getDefaultEngine.mockReturnValue(new PlayerEngine(surface));
    let takes = 0;
    mocks.resolveAudioSourceAction.mockImplementation(
      async (_provider: string, id: string) => ({
        ok: true,
        source: {
          url: `https://cdn.example/${id}-take${(takes += 1)}.m4a`,
          mimeType: "audio/mp4",
        },
      }),
    );
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().bindEngine(null);
    vi.clearAllMocks();
  });

  it("recovers a dead stream with a fresh URL and resumes at position", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa", "Song A"));
    await bar().findByRole("button", { name: "Pause" });
    const firstSrc = surface.src;
    expect(firstSrc).toContain("take1");

    surface.currentTime = 100;
    surface.error = { code: 2 };
    surface.dispatch(EventEnum.error);

    // Fresh resolution (take2), reloaded at the saved position, playing.
    await waitFor(() => expect(surface.src).toContain("take2"), {
      timeout: 5000,
    });
    expect(surface.currentTime).toBe(100);
    await bar().findByRole("button", { name: "Pause" });
    expect(screen.queryByRole("status")).toBeNull();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("aaaaaaaaaaa");
  });

  it("never lets a stale recovery override a skipped track", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore
      .getState()
      .replaceQueue([
        youtubeTrack("aaaaaaaaaaa", "Song A"),
        youtubeTrack("bbbbbbbbbbb", "Song B"),
      ]);
    await bar().findByRole("button", { name: "Pause" });

    surface.error = { code: 2 };
    surface.dispatch(EventEnum.error);
    // User skips before the recovery round fires.
    usePlayerStore.getState().next();

    await waitFor(
      () => expect(surface.src).toContain("bbbbbbbbbbb-take"),
      { timeout: 5000 },
    );
    // Past the recovery window: A was never reloaded, B stayed active.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(surface.src).toContain("bbbbbbbbbbb-take");
    expect(usePlayerStore.getState().currentTrack?.id).toBe("bbbbbbbbbbb");
    const aResolves = mocks.resolveAudioSourceAction.mock.calls.filter(
      ([, id]) => id === "aaaaaaaaaaa",
    );
    expect(aResolves).toHaveLength(1);
  });

  it("pausing during recovery loads the fresh source without autoplay", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa", "Song A"));
    await bar().findByRole("button", { name: "Pause" });
    const playsBefore = surface.play as unknown as { mock: { calls: unknown[] } };
    const playCallsBefore = playsBefore.mock.calls.length;

    surface.error = { code: 2 };
    surface.dispatch(EventEnum.error);
    usePlayerStore.getState().pause();

    await waitFor(() => expect(surface.src).toContain("take2"), {
      timeout: 5000,
    });
    expect(playsBefore.mock.calls.length).toBe(playCallsBefore);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    await bar().findByRole("button", { name: "Play" });
  });

  it("surfaces one final error after retries are exhausted", async () => {
    let calls = 0;
    mocks.resolveAudioSourceAction.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          source: { url: "https://cdn.example/first.m4a" },
        };
      }
      return {
        ok: false,
        error: {
          name: "PlaybackResolutionError",
          code: "PLAYBACK_RESOLUTION_ERROR",
          message: "Upstream timeout",
          retryable: true,
          provider: "youtube",
        },
      };
    });
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa", "Song A"));
    await bar().findByRole("button", { name: "Pause" });

    surface.error = { code: 2 };
    surface.dispatch(EventEnum.error);

    // Initial resolve + two bounded recovery rounds, then one final error.
    await waitFor(
      () => expect(screen.getByRole("status").textContent).toContain(
        "Upstream timeout",
      ),
      { timeout: 8000 },
    );
    expect(mocks.resolveAudioSourceAction).toHaveBeenCalledTimes(3);
    // Stays on the failed track; the queue is untouched.
    expect(usePlayerStore.getState().currentTrack?.id).toBe("aaaaaaaaaaa");
    expect(usePlayerStore.getState().queue).toHaveLength(1);
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("retries a failed track through the facade without touching the queue", async () => {
    let calls = 0;
    mocks.resolveAudioSourceAction.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          source: { url: "https://cdn.example/first.m4a" },
        };
      }
      return {
        ok: false,
        error: {
          name: "PlaybackResolutionError",
          code: "PLAYBACK_RESOLUTION_ERROR",
          message: "Upstream timeout",
          retryable: true,
          provider: "youtube",
        },
      };
    });
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa", "Song A"));
    await bar().findByRole("button", { name: "Pause" });

    surface.error = { code: 2 };
    surface.dispatch(EventEnum.error);
    await waitFor(
      () => expect(screen.getByRole("status").textContent).toContain(
        "Upstream timeout",
      ),
      { timeout: 8000 },
    );
    expect(mocks.resolveAudioSourceAction).toHaveBeenCalledTimes(3);

    // Explicit user retry: new generation, fresh resolution budget, same
    // queue and track. The source still fails, so the error resurfaces —
    // bounded, without loops or queue damage.
    fireEvent.click(screen.getByRole("button", { name: "Retry playback" }));
    await waitFor(
      () => expect(mocks.resolveAudioSourceAction.mock.calls.length).toBeGreaterThan(3),
      { timeout: 8000 },
    );
    await waitFor(
      () => expect(screen.getByRole("status").textContent).toContain(
        "Upstream timeout",
      ),
      { timeout: 8000 },
    );
    expect(usePlayerStore.getState().currentTrack?.id).toBe("aaaaaaaaaaa");
    expect(usePlayerStore.getState().queue).toHaveLength(1);
  });
});
