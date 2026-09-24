// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
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

function youtubeTrack(id: string): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: "UC1",
    artistName: "Artist",
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

describe("PlayerHost + PlaybackController", () => {
  beforeEach(() => {
    resetStore();
    const surface = new FakeAudioSurface();
    mocks.getDefaultEngine.mockReturnValue(new PlayerEngine(surface));
    mocks.resolveAudioSourceAction.mockResolvedValue({
      ok: true,
      source: { url: "https://cdn.example/resolved.m4a", mimeType: "audio/mp4" },
    });
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().bindEngine(null);
    vi.clearAllMocks();
  });

  it("resolves youtube tracks end-to-end through the controller", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await waitFor(() =>
      expect(mocks.resolveAudioSourceAction).toHaveBeenCalledWith(
        "youtube",
        "aaaaaaaaaaa",
      ),
    );
    const engine = mocks.getDefaultEngine.mock.results[0]?.value as PlayerEngine;
    const surface = (engine as unknown as { surface: FakeAudioSurface }).surface;
    await waitFor(() => expect(surface.src).toBe("https://cdn.example/resolved.m4a"));
    // Canonical track identity untouched: no stream URL stored.
    expect(usePlayerStore.getState().currentTrack?.streamUrl).toBeUndefined();
  });

  it("surfaces resolution failure in the player error state", async () => {
    mocks.resolveAudioSourceAction.mockResolvedValue({
      ok: false,
      error: {
        name: "PlaybackResolutionError",
        code: "PLAYBACK_RESOLUTION_ERROR",
        message: "Video unavailable",
        retryable: false,
        provider: "youtube",
      },
    });
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await waitFor(() =>
      expect(usePlayerStore.getState().error).toEqual({
        kind: "unavailable",
        message: "Video unavailable",
      }),
    );
    expect(usePlayerStore.getState().queue).toHaveLength(1);
  });

  it("StrictMode remount leaves exactly one active controller", async () => {
    const { unmount } = render(
      <StrictMode>
        <PlayerHost />
      </StrictMode>,
    );
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await waitFor(() => expect(mocks.resolveAudioSourceAction).toHaveBeenCalled());

    // Full unmount + remount: the disposed controller must stay inert.
    unmount();
    cleanup();
    resetStore();
    const surface = new FakeAudioSurface();
    mocks.getDefaultEngine.mockReturnValue(new PlayerEngine(surface));
    mocks.resolveAudioSourceAction.mockClear();
    mocks.resolveAudioSourceAction.mockResolvedValue({
      ok: true,
      source: { url: "https://cdn.example/remount.m4a" },
    });
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("bbbbbbbbbbb"));
    await waitFor(() => expect(surface.src).toBe("https://cdn.example/remount.m4a"));
    expect(
      mocks.resolveAudioSourceAction.mock.calls.filter(
        ([, id]) => id === "bbbbbbbbbbb",
      ),
    ).toHaveLength(1);
  });

  it("does not leak the resolved url into persistence payloads", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await waitFor(() => expect(mocks.resolveAudioSourceAction).toHaveBeenCalled());
    const track = usePlayerStore.getState().currentTrack;
    expect(track).toBeDefined();
    expect(JSON.stringify(track)).not.toContain("cdn.example");
  });

  it("loadedmetadata still completes the load cycle", async () => {
    const surface = new FakeAudioSurface();
    mocks.getDefaultEngine.mockReturnValue(new PlayerEngine(surface));
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(youtubeTrack("aaaaaaaaaaa"));
    await waitFor(() => expect(surface.src).toBe("https://cdn.example/resolved.m4a"));
    surface.duration = 200;
    surface.dispatch(EventEnum.loadedmetadata);
    await waitFor(() => expect(usePlayerStore.getState().isLoading).toBe(false));
  });
});
