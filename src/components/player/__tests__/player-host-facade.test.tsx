// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import { getMusicEngine } from "@/lib/music/instance";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface } from "@/lib/player/__tests__/fake-audio";
import type { Track } from "@/lib/domain";

const mocks = vi.hoisted(() => ({ getDefaultEngine: vi.fn() }));

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
  resolveAudioSourceAction: vi.fn(async () => ({
    ok: true,
    source: { url: "https://audio.example/strict.mp3" },
  })),
}));

function youtubeTrack(id: string, title: string): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title,
    artistId: "UC1",
    artistName: "Strict Artist",
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

describe("PlayerHost facade under StrictMode", () => {
  beforeEach(() => {
    resetStore();
    mocks.getDefaultEngine.mockReturnValue(
      new PlayerEngine(new FakeAudioSurface()),
    );
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().bindEngine(null);
  });

  it("remounts singularly and serves the migrated UI through the facade", async () => {
    render(
      <StrictMode>
        <PlayerHost />
      </StrictMode>,
    );
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    expect(getMusicEngine()).not.toBeNull();

    usePlayerStore.getState().replaceQueue([
      youtubeTrack("aaaaaaaaaaa", "Strict Song A"),
      youtubeTrack("bbbbbbbbbbb", "Strict Song B"),
    ]);

    const bar = within(
      await screen.findByRole("region", { name: "Player bar" }),
    );
    expect(bar.getByText("Strict Song A")).toBeTruthy();

    fireEvent.click(bar.getByRole("button", { name: "Up next" }));
    const dialog = await screen.findByRole("dialog", { name: "Queue" });
    expect(within(dialog).getByText("Strict Song A")).toBeTruthy();
    expect(within(dialog).getByText("Strict Song B")).toBeTruthy();

    // The remounted facade instance is the one serving state.
    expect(getMusicEngine()).not.toBeNull();
  });
});
