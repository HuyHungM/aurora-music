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

  it("closes on a click elsewhere in the dialog that hosts it", async () => {
    // A track menu can be opened from inside the queue panel or the full
    // player, and both are dialogs. The outside-click test used to exempt
    // every dialog, which meant nothing inside the hosting panel could ever
    // dismiss the menu.
    const user = userEvent.setup();
    render(
      <div role="dialog" aria-label="Hộp thoại">
        <TrackActionMenu track={makeTrack("t1")} />
        <button type="button">Nơi khác</button>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Thao tác với Track t1" });
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Thao tác với bài hát" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Nơi khác" }));
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Thao tác với bài hát" })).toBeNull(),
    );
    // The host survives; only the menu went away. Focus is left on the
    // button the user actually pressed, which is where a pointer click put it.
    expect(screen.getByRole("dialog", { name: "Hộp thoại" })).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("stays open when a click lands in a different dialog", async () => {
    // The create-playlist dialog is portaled to <body> and lives outside the
    // menu. Working through its form must not collapse the menu underneath.
    const user = userEvent.setup();
    render(<TrackActionMenu track={makeTrack("t1")} />);
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.innerHTML = '<button type="button">Trong hộp thoại khác</button>';
    document.body.appendChild(other);

    const trigger = screen.getByRole("button", { name: "Thao tác với Track t1" });
    await user.click(trigger);
    await user.click(other.querySelector("button")!);
    expect(screen.getByRole("menu", { name: "Thao tác với bài hát" })).toBeTruthy();
    other.remove();
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

  it("shows a heart icon beside Like, aligned with the other row icons", async () => {
    // The Like row used to be the one row without an icon (a check when
    // liked, an empty spacer when not). It now carries the same HeartIcon
    // the LikeButton uses, at the same 16px as every sibling row.
    const user = userEvent.setup();
    const onLikeToggle = vi.fn();
    const { container } = render(
      <TrackActionMenu track={makeTrack("t1")} showLike={true} onLikeToggle={onLikeToggle} />,
    );

    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    const item = screen.getByRole("menuitem", { name: "Thích" });
    const svg = item.querySelector("svg");
    expect(svg).not.toBeNull();
    // Decorative: the menuitem's accessible name stays the label text alone.
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    // Unliked: outline heart in the muted tone every sibling row uses.
    expect(svg?.className.baseVal ?? svg?.getAttribute("class") ?? "").toContain(
      "text-text-muted",
    );
    // Same geometry as the Play-next / queue / radio / playlist rows.
    expect(item.className).toContain("gap-3");
    expect(container.querySelector('[role="menu"]')?.className).toContain("w-48");
  });

  it("fills the heart with the accent when liked", async () => {
    // Mirrors LikeButton's `fill-accent`: liked is a filled heart, not a
    // different glyph, and the row text flips to Unlike on the same state.
    const user = userEvent.setup();
    const onLikeToggle = vi.fn();
    render(
      <TrackActionMenu track={makeTrack("t1")} showLike={true} isLiked={true} onLikeToggle={onLikeToggle} />,
    );

    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    const item = screen.getByRole("menuitem", { name: "Bỏ thích" });
    const svg = item.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    const classes = svg?.className.baseVal ?? svg?.getAttribute("class") ?? "";
    expect(classes).toContain("fill-accent");
    expect(classes).toContain("text-accent");
  });

  it("fires the existing Like action when the row is clicked", async () => {
    // The icon is decoration inside the same button: no nested control, no
    // propagation change, the row still calls through. The menu itself stays
    // open here in the bare harness because the passed `onLikeToggle` is a
    // bare spy — production callers route through `shared.toggle`, and the
    // like mutation is what the menu-close assertions elsewhere cover. What
    // matters for this row is that the click reaches the existing handler
    // exactly once, which the bare checkmark version of this row never had
    // a regression test for either.
    const user = userEvent.setup();
    const onLikeToggle = vi.fn();
    render(<TrackActionMenu track={makeTrack("t1")} showLike={true} onLikeToggle={onLikeToggle} />);

    await user.click(screen.getByRole("button", { name: "Thao tác với Track t1" }));
    await user.click(screen.getByRole("menuitem", { name: "Thích" }));

    expect(onLikeToggle).toHaveBeenCalledTimes(1);
  });
});
