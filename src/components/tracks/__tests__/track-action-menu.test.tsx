// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { TrackActionMenu } from "@/components/tracks/track-action-menu";
import { usePlayerStore } from "@/lib/player/store";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";
import type { Track } from "@/lib/domain";

vi.mock("@/lib/player/engine-factory", () => ({
  createPlayerEngine: () => ({
    load: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    seek: vi.fn(),
    destroy: vi.fn(),
    setVolume: vi.fn(),
    getVolume: () => 1,
    getCurrentTime: () => 0,
    getDuration: () => 0,
    on: vi.fn(),
  }),
}));

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  createPlaylistAction: vi.fn().mockResolvedValue({ ok: true, playlistId: "new" }),
}));

let unmountFacade: (() => void) | undefined;

beforeEach(() => {
  unmountFacade = mountTestFacade();
});

afterEach(() => {
  cleanup();
  unmountFacade?.();
  unmountFacade = undefined;
  usePlayerStore.setState({
    queue: [],
    playOrder: [],
    position: 0,
    currentTrack: null,
    isPlaying: false,
    shuffle: false,
    repeat: "off",
    volume: 1,
    muted: false,
    isLoading: false,
    error: null,
    isQueueOpen: false,
    qualifiedTrackKey: null,
    duration: 0,
  });
});

function makeTrack(id: string): Track {
  return {
    id,
    provider: "mock",
    providerTrackId: `mock-${id}`,
    title: `Track ${id}`,
    artistId: "a1",
    artistName: "Test Artist",
    streamUrl: `https://example.com/${id}.mp3`,
  };
}

describe("TrackActionMenu", () => {
  it("renders menu button with accessible label", () => {
    render(<TrackActionMenu track={makeTrack("t1")} />);
    expect(screen.getByRole("button", { name: "Thao tác với Track t1" })).toBeTruthy();
  });

  it("opens menu when button is clicked", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    
    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    
    expect(screen.getByRole("menu", { name: "Thao tác với bài hát" })).toBeTruthy();
  });

  it("moves focus into the menu and returns it to the trigger on Escape", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    const trigger = screen.getByRole("button", { name: "Thao tác với Track t1" });

    await user.click(trigger);
    expect(document.activeElement?.textContent).toContain("Phát tiếp theo");
    await user.keyboard("{Escape}");
    // Focus returns at close request; the menu is still mounted, animating
    // out and already inert, then unmounts when the exit ends. Queried by
    // attribute, not role: an inert menu is correctly invisible to
    // assistive tech, so a role query missing it would be the point.
    expect(document.activeElement).toBe(trigger);
    expect(
      document.querySelector('[data-presence="exiting"][role="menu"]'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Thao tác với bài hát" })).toBeNull();
    });
  });

  it("moves focus with arrow keys inside the menu", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));

    expect(document.activeElement?.textContent).toContain("Phát tiếp theo");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("Thêm vào hàng chờ");
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toContain("Phát tiếp theo");
  });

  it("shows Play next and Add to queue actions", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    
    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    
    expect(screen.getByRole("menuitem", { name: "Phát tiếp theo" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Thêm vào hàng chờ" })).toBeTruthy();
  });

  it("calls playNext when Play next is clicked", async () => {
    const user = userEvent.setup();
    const track = makeTrack("t1");
    usePlayerStore.setState({
      queue: [makeTrack("existing")],
      playOrder: [0],
      position: 0,
    });
    
    render(<TrackActionMenu track={track} />);
    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    await user.click(screen.getByRole("menuitem", { name: "Phát tiếp theo" }));
    
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["existing", "t1"]);
  });

  it("calls addToQueue when Add to queue is clicked", async () => {
    const user = userEvent.setup();
    const track = makeTrack("t1");
    usePlayerStore.setState({
      queue: [makeTrack("existing")],
      playOrder: [0],
      position: 0,
    });
    
    render(<TrackActionMenu track={track} />);
    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    await user.click(screen.getByRole("menuitem", { name: "Thêm vào hàng chờ" }));
    
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["existing", "t1"]);
    // addToQueue appends to the end
    expect(state.playOrder).toEqual([0, 1]);
  });

  it("shows like action when showLike is true", async () => {
    const user = userEvent.setup();
    const onLikeToggle = vi.fn();
    render(<TrackActionMenu track={makeTrack("t1")} showLike={true} onLikeToggle={onLikeToggle} />);
    
    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    
    expect(screen.getByRole("menuitem", { name: "Thích" })).toBeTruthy();
  });

  it("shows unlike action when showLike is true and isLiked is true", async () => {
    const user = userEvent.setup();
    const onLikeToggle = vi.fn();
    render(<TrackActionMenu track={makeTrack("t1")} showLike={true} isLiked={true} onLikeToggle={onLikeToggle} />);
    
    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    
    expect(screen.getByRole("menuitem", { name: "Bỏ thích" })).toBeTruthy();
  });

  it("hides like action when showLike is false", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} showLike={false} />);
    
    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    
    expect(screen.queryByRole("menuitem", { name: "Thích" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Bỏ thích" })).toBeNull();
  });
});
