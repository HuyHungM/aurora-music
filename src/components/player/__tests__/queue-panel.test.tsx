// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";

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
    source: { url: "https://audio.example/resolved.mp3" },
  })),
}));

// Engine-backed UI only renders queue rows whose tracks convert to an
// engine identity, so fixtures use the youtube provider here.
function yt(id: string, extra: Record<string, unknown> = {}) {
  return makePlayableTrack(id, { provider: "youtube", providerTrackId: id, ...extra });
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
    qualifiedTrackKey: null,
  });
}

const bar = () => within(screen.getByRole("region", { name: "Thanh phát nhạc" }));
const queueDialog = () => screen.getByRole("dialog", { name: "Hàng chờ" });
const rows = () => within(queueDialog()).getAllByRole("listitem");

describe("QueuePanel", () => {
  beforeEach(() => {
    resetStore();
    const surface = new FakeAudioSurface();
    const engine = new PlayerEngine(surface);
    mocks.getDefaultEngine.mockReturnValue(engine);
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().bindEngine(null);
  });

  it("opens from the bar, lists the queue, and closes again", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    const store = usePlayerStore.getState();
    store.replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
      yt("c", { title: "Track C", artistName: "Three" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    const dialog = await screen.findByRole("dialog", { name: "Hàng chờ" });
    expect(within(dialog).getByText("3 bài hát")).toBeTruthy();
    expect(within(dialog).getByText("Track A")).toBeTruthy();
    expect(within(dialog).getByText("Track B")).toBeTruthy();
    expect(within(dialog).getByText("Track C")).toBeTruthy();
    expect(within(dialog).getAllByText("Đang phát")).toHaveLength(2);

    fireEvent.click(within(dialog).getByRole("button", { name: "Đóng hàng chờ" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Hàng chờ" })).toBeNull());
    expect(usePlayerStore.getState().isQueueOpen).toBe(false);
  });

  it("switches to a queued track from the panel", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    const store = usePlayerStore.getState();
    store.replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
      yt("c", { title: "Track C", artistName: "Three" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
    fireEvent.click(within(queueDialog()).getByRole("button", { name: "Phát Track C" }));
    await waitFor(() => expect(usePlayerStore.getState().currentTrack?.id).toBe("c"));
    expect(usePlayerStore.getState().position).toBe(2);
    expect(rows()).toHaveLength(3);
  });

  it("also opens from the mobile mini player and shows the mini player controls", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().playTrack(yt("m", { title: "Track M", artistName: "Me" }));
    const mini = within(await screen.findByRole("region", { name: "Trình phát thu gọn" }));
    fireEvent.click(mini.getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });
    expect(within(queueDialog()).getByText("Track M")).toBeTruthy();
  });

  /**
   * Outside dismissal. At `lg` the panel has no scrim, so a press anywhere
   * in the page previously left it open over the content. One `pointerdown`
   * listener per open lifecycle covers mouse and touch together.
   */
  it("stays open when a press lands inside the panel", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    const dialog = await screen.findByRole("dialog", { name: "Hàng chờ" });

    // The panel's own header — not a control, so nothing else can explain
    // the press being absorbed.
    fireEvent.pointerDown(dialog.querySelector("h2") as HTMLElement);
    expect(usePlayerStore.getState().isQueueOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Hàng chờ" })).toBeTruthy();
  });

  it("closes when a press lands outside the panel", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Hàng chờ" })).toBeNull(),
    );
    expect(usePlayerStore.getState().isQueueOpen).toBe(false);
  });

  it("does not treat the queue trigger as outside, so its own press is absorbed", async () => {
    // The failure mode this guards: the same press that opens the panel is
    // also seen by the global listener, which closes it again. Containment is
    // tested against the DOM, not against state, so it cannot race.
    //
    // The trigger is OPEN-ONLY (`openQueue` sets the flag; it does not
    // toggle), and that is deliberately left as it is: adding a toggle would
    // change trigger behaviour, which is not what this task is for. What the
    // exemption guarantees is that the outside handler never acts as a
    // de-facto toggle either.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
    ]);

    const trigger = bar().getByRole("button", { name: "Tiếp theo" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    fireEvent.pointerDown(trigger);
    expect(usePlayerStore.getState().isQueueOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Hàng chờ" })).toBeTruthy();

    fireEvent.click(trigger);
    expect(usePlayerStore.getState().isQueueOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Hàng chờ" })).toBeTruthy();
  });

  it("leaves another overlay alone instead of dismissing the queue under it", async () => {
    // The create-playlist dialog is portaled to `document.body`, so it is not
    // a descendant of the panel. Pressing inside it must not close the queue
    // that opened it.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    const field = document.createElement("input");
    overlay.appendChild(field);
    document.body.appendChild(overlay);

    fireEvent.pointerDown(field);
    expect(usePlayerStore.getState().isQueueOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Hàng chờ" })).toBeTruthy();

    overlay.remove();
  });

  it("leaves the row menu alone while it is open inside the panel", async () => {
    // The row menu renders into the panel's own layer, so it is a descendant
    // of the panel and containment covers it without a special case.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    fireEvent.click(
      within(queueDialog()).getByRole("button", { name: "Thao tác với Track B" }),
    );
    const menu = await screen.findByRole("menu", { name: "Thao tác với bài hát" });
    fireEvent.pointerDown(menu);
    expect(usePlayerStore.getState().isQueueOpen).toBe(true);
  });

  it("stops listening once closed", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
    ]);

    const trigger = bar().getByRole("button", { name: "Tiếp theo" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Hàng chờ" });
    fireEvent.click(within(queueDialog()).getByRole("button", { name: "Đóng hàng chờ" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Hàng chờ" })).toBeNull(),
    );

    // Listener released: a press now is inert rather than reaching a panel
    // that is mid-exit.
    fireEvent.pointerDown(document.body);
    expect(usePlayerStore.getState().isQueueOpen).toBe(false);
  });

  it("moves focus between its own items with the arrow keys", async () => {
    // Regression pin. `role="menu"` promises arrow-key navigation and this menu
    // had none: ArrowDown fell through to the panel-level handler, which maps
    // ↓/↑ to next/previous TRACK. So ↓ inside an open row menu skipped to the
    // next track instead of moving to the next menu item.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
      yt("c", { title: "Track C", artistName: "Three" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });
    fireEvent.click(
      within(queueDialog()).getByRole("button", { name: "Thao tác với Track B" }),
    );
    const menu = await screen.findByRole("menu", { name: "Thao tác với bài hát" });

    const items = () =>
      Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items().length).toBeGreaterThan(1);

    items()[0].focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[1]);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items()[0]);

    // Wraps, and never escapes to the panel's next/previous handler.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items()[items().length - 1]);

    const positionBefore = usePlayerStore.getState().position;
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(usePlayerStore.getState().position).toBe(positionBefore);
    expect(usePlayerStore.getState().isQueueOpen).toBe(true);
  });

  it("leaves Escape to the playlist picker instead of closing the whole panel", async () => {
    // The picker owns Escape. Returning from the row menu's capture handler was
    // not enough: the event continued to the panel-level bubble handler and
    // closed the entire queue panel, yanking it out from under the picker.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });
    fireEvent.click(
      within(queueDialog()).getByRole("button", { name: "Thao tác với Track B" }),
    );
    await screen.findByRole("menu", { name: "Thao tác với bài hát" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Thêm vào playlist" }));

    const panel = await screen.findByRole("dialog", { name: "Hàng chờ" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    // The panel is still open — the picker consumed the key.
    expect(usePlayerStore.getState().isQueueOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Hàng chờ" })).toBeTruthy();
    void panel;
  });

  it("actually removes the row and confirms it", async () => {
    // Regression pin. Removal moved from the row menu up to the panel so the
    // panel can name the removed track in the confirmation; nothing covered
    // the removal itself, and a report-only path removed nothing at all.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
      yt("c", { title: "Track C", artistName: "Three" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    fireEvent.click(
      within(queueDialog()).getByRole("button", { name: "Thao tác với Track B" }),
    );
    await screen.findByRole("menu", { name: "Thao tác với bài hát" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Xóa khỏi hàng chờ" }));

    await waitFor(() => {
      expect(usePlayerStore.getState().queue.map((track) => track.id)).toEqual([
        "a",
        "c",
      ]);
    });
    expect(within(queueDialog()).queryByText("Track B")).toBeNull();
  });

it("moves focus into the panel on open and back to Up next on Escape", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
    ]);

    const trigger = bar().getByRole("button", { name: "Tiếp theo" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Hàng chờ" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Hàng chờ" })).toBeNull(),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Tiếp theo");
  });

  it("returns focus to the row trigger when its menu closes", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    const trigger = within(queueDialog()).getByRole("button", {
      name: "Thao tác với Track B",
    });
    fireEvent.click(trigger);
    expect(document.activeElement?.textContent).toContain("Thêm vào playlist");
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(
        within(queueDialog()).queryByRole("button", {
          name: "Xóa khỏi hàng chờ",
        }),
      ).toBeNull(),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Thao tác với Track B",
    );
  });

  it("renders the row menu in the panel's layer, outside the scrolling list", async () => {
    // The list is a scroll container, and a scroll container clips its
    // contents - including a menu opening downward from a row near the bottom
    // of it. The surface therefore renders into the panel's own layer, which
    // is a sibling of the list, and takes explicit offsets from there.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    const dialog = queueDialog();
    const layer = dialog.querySelector("[data-queue-menu-layer]");
    expect(layer, "the panel owns a menu layer").toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Thao tác với Track B" }),
    );
    const menu = await screen.findByRole("menu", { name: "Thao tác với bài hát" });
    expect(menu.parentElement).toBe(layer);
    expect(dialog.contains(menu)).toBe(true);

    // The list must not be the surface's ancestor: that is the whole point.
    const scroller = dialog.querySelector<HTMLElement>(".overflow-y-auto")!;
    expect(scroller).toBeTruthy();
    expect(scroller.contains(menu)).toBe(false);
  });

  it("dismisses the row menu when the list scrolls under it", async () => {
    // The surface is positioned from the row it belongs to, and the row
    // moves. Nothing but a scroll event can say so, so a surface left in
    // place would float over rows it no longer belongs to.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    fireEvent.click(
      within(queueDialog()).getByRole("button", { name: "Thao tác với Track B" }),
    );
    await screen.findByRole("menu", { name: "Thao tác với bài hát" });

    // A scroll on a scroll container does not bubble, so this only arrives
    // through the capture listener. Dispatching it non-bubbling keeps the
    // test honest about which path it is exercising.
    const scroller = queueDialog().querySelector<HTMLElement>(".overflow-y-auto")!;
    scroller.dispatchEvent(new Event("scroll"));

    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Thao tác với bài hát" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Hàng chờ" })).toBeTruthy();
  });

  it("dismisses the row menu on a click elsewhere in the panel", async () => {
    // The panel is itself a dialog. Treating every dialog as off-limits to
    // the outside-click test meant nothing inside the panel could ever close
    // the menu, which left Escape as the only way out.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A", artistName: "One" }),
      yt("b", { title: "Track B", artistName: "Two" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    fireEvent.click(
      within(queueDialog()).getByRole("button", { name: "Thao tác với Track B" }),
    );
    await screen.findByRole("menu", { name: "Thao tác với bài hát" });

    fireEvent.mouseDown(queueDialog());

    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Thao tác với bài hát" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Hàng chờ" })).toBeTruthy();
  });
});