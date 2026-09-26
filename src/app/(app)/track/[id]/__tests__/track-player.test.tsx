// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrackPlayer } from "../track-player";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";

let unmountFacade: (() => void) | undefined;

vi.mock("@/app/actions/track", () => ({
  likeTrackAction: vi.fn(async () => ({ ok: true, liked: true })),
  unlikeTrackAction: vi.fn(async () => ({ ok: true, liked: false })),
  checkTrackLikedAction: vi.fn(async () => false),
}));

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  createPlaylistAction: vi.fn().mockResolvedValue({ ok: true, playlistId: "new" }),
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
  });
}

describe("TrackPlayer", () => {
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

  it("renders track title and artist", () => {
    const track = makePlayableTrack("t1", { title: "My Song", artistName: "My Artist" });
    render(<TrackPlayer track={track} initialLiked={false} />);
    expect(screen.getByText("My Song")).toBeTruthy();
    expect(screen.getByText("My Artist")).toBeTruthy();
  });

  it("shows Play button when not playing", () => {
    const track = makePlayableTrack("t1");
    render(<TrackPlayer track={track} initialLiked={false} />);
    expect(screen.getByRole("button", { name: "Phát Track t1" })).toBeTruthy();
  });

  it("starts playback when Play is clicked", async () => {
    const track = makePlayableTrack("t1");
    render(<TrackPlayer track={track} initialLiked={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Phát Track t1" }));
    await waitFor(() =>
      expect(usePlayerStore.getState().currentTrack?.id).toBe("t1"),
    );
  });

  it("toggles to Pause when playing", async () => {
    const track = makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1" });
    render(<TrackPlayer track={track} initialLiked={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Phát Track t1" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Tạm dừng Track t1" })).toBeTruthy(),
    );
  });

  it("shows filled heart when liked", () => {
    const track = makePlayableTrack("t1");
    render(<TrackPlayer track={track} initialLiked={true} />);
    const likeButton = screen.getByRole("button", { name: "Bỏ thích Track t1" });
    expect(likeButton).toBeTruthy();
  });

  it("shows empty heart when not liked", () => {
    const track = makePlayableTrack("t1");
    render(<TrackPlayer track={track} initialLiked={false} />);
    const likeButton = screen.getByRole("button", { name: "Thích Track t1" });
    expect(likeButton).toBeTruthy();
  });

  it("shows album name when available", () => {
    const track = makePlayableTrack("t1", { albumName: "My Album" });
    render(<TrackPlayer track={track} initialLiked={false} />);
    expect(screen.getByText("My Album")).toBeTruthy();
  });

  it("shows explicit badge when track is explicit", () => {
    const track = makePlayableTrack("t1", { explicit: true });
    render(<TrackPlayer track={track} initialLiked={false} />);
    expect(screen.getByText("Nhạy cảm")).toBeTruthy();
  });

  it("shows genres when available", () => {
    const track = makePlayableTrack("t1", { genres: ["Rock", "Alternative"] });
    render(<TrackPlayer track={track} initialLiked={false} />);
    expect(screen.getByText("Rock")).toBeTruthy();
    expect(screen.getByText("Alternative")).toBeTruthy();
  });

  /**
   * Phase 49 regression. `genres` is a provider-supplied JSON column with no
   * uniqueness guarantee on any read path, and the chips were keyed directly
   * by the genre string. A stored `["pop","pop"]` therefore rendered a
   * duplicate chip AND handed React a duplicate key - the same class of
   * provider-value-as-identity bug that `TrackList` was fixed for.
   */
  it("de-duplicates repeated genres so keys stay unique", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const track = makePlayableTrack("t1", { genres: ["pop", "pop", "indie"] });
      render(<TrackPlayer track={track} initialLiked={false} />);

      // Each genre appears exactly once.
      expect(screen.getAllByText("pop")).toHaveLength(1);
      expect(screen.getAllByText("indie")).toHaveLength(1);
      // ...and React never saw a duplicate key.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
