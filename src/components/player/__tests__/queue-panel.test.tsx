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
});