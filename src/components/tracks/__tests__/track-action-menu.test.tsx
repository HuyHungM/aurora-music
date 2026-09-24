// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: "Actions for Track t1" })).toBeTruthy();
  });

  it("opens menu when button is clicked", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    
    await user.click(screen.getByRole("button", { name: "Actions for Track t1" }));
    
    expect(screen.getByRole("menu", { name: "Track actions" })).toBeTruthy();
  });

  it("moves focus into the menu and returns it to the trigger on Escape", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    const trigger = screen.getByRole("button", { name: "Actions for Track t1" });

    await user.click(trigger);
    expect(document.activeElement?.textContent).toContain("Play next");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Track actions" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus with arrow keys inside the menu", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    await user.click(screen.getByRole("button", { name: "Actions for Track t1" }));

    expect(document.activeElement?.textContent).toContain("Play next");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toContain("Add to queue");
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toContain("Play next");
  });

  it("shows Play next and Add to queue actions", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    
    await user.click(screen.getByRole("button", { name: "Actions for Track t1" }));
    
    expect(screen.getByRole("menuitem", { name: "Play next" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Add to queue" })).toBeTruthy();
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
    await user.click(screen.getByRole("button", { name: "Actions for Track t1" }));
    await user.click(screen.getByRole("menuitem", { name: "Play next" }));
    
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
    await user.click(screen.getByRole("button", { name: "Actions for Track t1" }));
    await user.click(screen.getByRole("menuitem", { name: "Add to queue" }));
    
    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["existing", "t1"]);
    // addToQueue appends to the end
    expect(state.playOrder).toEqual([0, 1]);
  });

  it("shows like action when showLike is true", async () => {
    const user = userEvent.setup();
    const onLikeToggle = vi.fn();
    render(<TrackActionMenu track={makeTrack("t1")} showLike={true} onLikeToggle={onLikeToggle} />);
    
    await user.click(screen.getByRole("button", { name: "Actions for Track t1" }));
    
    expect(screen.getByRole("menuitem", { name: "Like" })).toBeTruthy();
  });

  it("shows unlike action when showLike is true and isLiked is true", async () => {
    const user = userEvent.setup();
    const onLikeToggle = vi.fn();
    render(<TrackActionMenu track={makeTrack("t1")} showLike={true} isLiked={true} onLikeToggle={onLikeToggle} />);
    
    await user.click(screen.getByRole("button", { name: "Actions for Track t1" }));
    
    expect(screen.getByRole("menuitem", { name: "Unlike" })).toBeTruthy();
  });

  it("hides like action when showLike is false", async () => {
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} showLike={false} />);
    
    await user.click(screen.getByRole("button", { name: "Actions for Track t1" }));
    
    expect(screen.queryByRole("menuitem", { name: "Like" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Unlike" })).toBeNull();
  });
});
