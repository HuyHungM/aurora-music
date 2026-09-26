// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePlayerStore } from "@/lib/player/store";
import { FullPlayer } from "@/components/player/full-player";
import { MiniPlayer } from "@/components/player/mini-player";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";

let unmountFacade: (() => void) | undefined;

const mocks = vi.hoisted(() => ({ getDefaultEngine: vi.fn() }));

vi.mock("@/lib/player/engine-factory", () => ({
  getDefaultEngine: mocks.getDefaultEngine,
}));

vi.mock("@/app/actions/playback", () => ({
  recordPlayedAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
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
    isFullPlayerOpen: false,
    qualifiedTrackKey: null,
  });
}

function mountWithEngine() {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  mocks.getDefaultEngine.mockReturnValue(engine);
  usePlayerStore.getState().bindEngine(engine);
  return { surface, engine };
}

describe("FullPlayer", () => {
  beforeEach(() => {
    resetStore();
    mountWithEngine();
    unmountFacade = mountTestFacade();
  });

  afterEach(() => {
    cleanup();
    unmountFacade?.();
    unmountFacade = undefined;
    usePlayerStore.getState().bindEngine(null);
  });

  it("does not render when no track is loaded", () => {
    render(<FullPlayer />);
    expect(screen.queryByRole("dialog", { name: "Đang phát" })).toBeNull();
  });

  it("does not render when isFullPlayerOpen is false", () => {
    usePlayerStore.setState({
      currentTrack: makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1", title: "Test Track", artistName: "Test Artist" }),
      isFullPlayerOpen: false,
    });
    render(<FullPlayer />);
    expect(screen.queryByRole("dialog", { name: "Đang phát" })).toBeNull();
  });

  it("renders when open with a track", () => {
    usePlayerStore.setState({
      currentTrack: makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1", title: "Test Track", artistName: "Test Artist" }),
      isFullPlayerOpen: true,
    });
    render(<FullPlayer />);
    expect(screen.getByRole("dialog", { name: "Đang phát" })).toBeTruthy();
    expect(screen.getByText("Test Track")).toBeTruthy();
    expect(screen.getByText("Test Artist")).toBeTruthy();
  });

  it("closes when close button is clicked", async () => {
    usePlayerStore.setState({
      currentTrack: makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1", title: "Test Track" }),
      isFullPlayerOpen: true,
    });
    render(<FullPlayer />);
    fireEvent.click(screen.getByRole("button", { name: "Đóng trình phát" }));
    await waitFor(() => expect(usePlayerStore.getState().isFullPlayerOpen).toBe(false));
  });

  it("toggles play/pause", async () => {
    usePlayerStore.setState({
      currentTrack: makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1", title: "Test Track" }),
      isFullPlayerOpen: true,
    });
    render(<FullPlayer />);
    const playBtn = screen.getByRole("button", { name: "Phát" });
    fireEvent.click(playBtn);
    await waitFor(() => expect(screen.getByRole("button", { name: "Tạm dừng" })).toBeTruthy());
  });

  it("renders seek, volume, shuffle, repeat, and queue controls", () => {
    usePlayerStore.setState({
      currentTrack: makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1", title: "Test Track" }),
      isFullPlayerOpen: true,
    });
    render(<FullPlayer />);
    expect(screen.getByRole("slider", { name: "Tua" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Âm lượng" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /phát ngẫu nhiên/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /repeat/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tiếp theo" })).toBeTruthy();
  });

  it("renders prev/next buttons", () => {
    usePlayerStore.setState({
      currentTrack: makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1", title: "Test Track" }),
      isFullPlayerOpen: true,
    });
    render(<FullPlayer />);
    expect(screen.getByRole("button", { name: "Bài trước" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bài tiếp theo" })).toBeTruthy();
  });

  it("moves focus into the dialog on open", () => {
    usePlayerStore.setState({
      currentTrack: makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1", title: "Test Track" }),
      isFullPlayerOpen: true,
    });
    render(<FullPlayer />);
    const dialog = screen.getByRole("dialog", { name: "Đang phát" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and returns focus to Expand player", async () => {
    usePlayerStore.setState({
      currentTrack: makePlayableTrack("t1", { provider: "youtube", providerTrackId: "t1", title: "Test Track" }),
      isFullPlayerOpen: true,
    });
    render(
      <>
        <MiniPlayer />
        <FullPlayer />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Đang phát" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Đang phát" })).toBeNull(),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Mở rộng trình phát",
    );
  });
});
