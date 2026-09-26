// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TrackRow } from "@/components/tracks/track-row";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";
import type { Track } from "@/lib/domain";

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  createPlaylistAction: vi.fn().mockResolvedValue({ ok: true, playlistId: "new" }),
}));

let unmountFacade: (() => void) | undefined;

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
  });
}

function spotifyTrack(id: string, youtubeMatch?: string): Track {
  const base = makePlayableTrack(id, {
    title: `Spotify song ${id}`,
    artistName: "Spotify Artist",
    provider: "spotify",
    providerTrackId: id,
  });
  const sources = [{ source: "spotify", id }];
  if (youtubeMatch) {
    sources.push({ source: "youtube", id: youtubeMatch });
  }
  return { ...base, id, metadata: { sources } };
}

describe("TrackRow provider-aware playability (Phase 37)", () => {
  beforeEach(() => {
    resetStore();
    const surface = new FakeAudioSurface();
    const engine = new PlayerEngine(surface);
    usePlayerStore.getState().bindEngine(engine);
    unmountFacade = mountTestFacade();
  });

  afterEach(() => {
    cleanup();
    unmountFacade?.();
    unmountFacade = undefined;
    usePlayerStore.getState().bindEngine(null);
  });

  it("renders Spotify metadata through the same unified row UI", () => {
    render(<TrackRow track={spotifyTrack("sp1", "yt1")} />);
    expect(screen.getByText("Spotify song sp1")).toBeTruthy();
    expect(screen.getByText("Spotify Artist")).toBeTruthy();
  });

  it("exposes Play for a Spotify track with a matched YouTube source", () => {
    render(<TrackRow track={spotifyTrack("sp1", "yt1")} />);
    expect(
      screen.getByRole("button", { name: "Phát Spotify song sp1" }),
    ).toBeTruthy();
  });

  it("shows Playback unavailable (no Play) for a catalog-only Spotify track", () => {
    render(<TrackRow track={spotifyTrack("sp1")} />);
    expect(
      screen.queryByRole("button", { name: "Phát Spotify song sp1" }),
    ).toBeNull();
    const unavailable = screen.getByRole("button", {
      name: "Không phát được Spotify song sp1",
    });
    expect(unavailable).toBeTruthy();
    expect(unavailable).toHaveProperty("disabled", true);
  });

  it("keeps queue/library affordances on catalog-only rows", () => {
    const onRemove = vi.fn();
    render(<TrackRow track={spotifyTrack("sp1")} onRemoveFromPlaylist={onRemove} />);
    // Remove-from-playlist (library management) stays available.
    expect(
      screen.getByRole("button", { name: "Xóa Spotify song sp1 khỏi playlist" }),
    ).toBeTruthy();
  });
});
