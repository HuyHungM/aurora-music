// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { HeroSection } from "@/components/home/hero-section";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";

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
    qualifiedTrackKey: null,
  });
}

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

describe("HeroSection", () => {
  it("renders featured track title and artist", () => {
    const track = makePlayableTrack("t1", { title: "Hero Track", artistName: "Hero Artist" });
    render(<HeroSection track={track} />);
    expect(screen.getByText("Hero Track")).toBeTruthy();
    expect(screen.getByText("Hero Artist")).toBeTruthy();
  });

  it("shows play button when track is not playing", () => {
    const track = makePlayableTrack("t1", { title: "Hero Track" });
    render(<HeroSection track={track} />);
    expect(screen.getByRole("button", { name: "Phát Hero Track" })).toBeTruthy();
  });

  it("starts playback when play button is clicked", async () => {
    const track = makePlayableTrack("t1", { title: "Hero Track" });
    render(<HeroSection track={track} />);
    fireEvent.click(screen.getByRole("button", { name: "Phát Hero Track" }));
    await waitFor(() =>
      expect(usePlayerStore.getState().currentTrack?.id).toBe("t1"),
    );
  });

  it("toggles to pause when track is already playing", async () => {
    const track = makePlayableTrack("t1", {
      title: "Hero Track",
      provider: "youtube",
      providerTrackId: "t1",
    });
    render(<HeroSection track={track} />);
    fireEvent.click(screen.getByRole("button", { name: "Phát Hero Track" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Tạm dừng Hero Track" })).toBeTruthy(),
    );
  });

  it("shows Spotlight label", () => {
    const track = makePlayableTrack("t1", { title: "Hero Track" });
    render(<HeroSection track={track} />);
    expect(screen.getByText("Nổi bật")).toBeTruthy();
  });

  it("shows album name when available", () => {
    const track = makePlayableTrack("t1", { title: "Hero Track", albumName: "Hero Album" });
    render(<HeroSection track={track} />);
    expect(screen.getByText(/Hero Album/)).toBeTruthy();
  });

  it("renders the canonical More button beside Play", () => {
    const track = makePlayableTrack("t1", { title: "Hero Track" });
    render(<HeroSection track={track} />);
    // Same localized trigger label as every other `TrackActionMenu`.
    const more = screen.getByRole("button", { name: "Thao tác với Hero Track" });
    expect(more).toBeTruthy();
    // The menu's own wrapper (`relative shrink-0`) sits beside Play inside
    // the same actions row — never an overlay on the artwork or metadata.
    const play = screen.getByRole("button", { name: "Phát Hero Track" });
    expect(play.parentElement).toBe(more.parentElement?.parentElement);
    expect(play.parentElement?.className).toContain("flex");
  });

  it("opens the existing track action menu from More", async () => {
    const user = userEvent.setup();
    const track = makePlayableTrack("t1", { title: "Hero Track" });
    render(<HeroSection track={track} />);
    await user.click(screen.getByRole("button", { name: "Thao tác với Hero Track" }));
    // The menu is the shared one: public actions present, no second menu.
    expect(screen.getByRole("menu", { name: "Thao tác với bài hát" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Phát tiếp theo" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Thêm vào hàng chờ" })).toBeTruthy();
  });

  it("opens More with the keyboard", async () => {
    const user = userEvent.setup();
    const track = makePlayableTrack("t1", { title: "Hero Track" });
    render(<HeroSection track={track} />);
    const more = screen.getByRole("button", { name: "Thao tác với Hero Track" });
    more.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menu", { name: "Thao tác với bài hát" })).toBeTruthy();
  });
});
