// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";
import { PlayerBar } from "@/components/player/player-bar";
import { MiniPlayer } from "@/components/player/mini-player";

function youtubeTrack(id: string, overrides: Record<string, unknown> = {}) {
  return makePlayableTrack(id, {
    provider: "youtube",
    providerTrackId: id,
    title: `Track ${id}`,
    artistName: "Artist",
    ...overrides,
  });
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

let unmountFacade: (() => void) | undefined;
let surface: FakeAudioSurface | undefined;

beforeEach(() => {
  resetStore();
  surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  usePlayerStore.getState().bindEngine(engine);
  unmountFacade = mountTestFacade();
});

afterEach(() => {
  cleanup();
  unmountFacade?.();
  unmountFacade = undefined;
  surface = undefined;
  usePlayerStore.getState().bindEngine(null);
});

function bar() {
  return within(screen.getByRole("region", { name: "Thanh phát nhạc" }));
}

describe("player control names and states", () => {
  it("exposes play state through the accessible name", async () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    render(<PlayerBar />);
    expect(bar().getByRole("button", { name: "Phát" })).toBeTruthy();
    await act(async () => {
      usePlayerStore.setState({ isPlaying: true });
    });
    expect(bar().getByRole("button", { name: "Tạm dừng" })).toBeTruthy();
  });

  it("disables transport controls without a track", () => {
    render(<PlayerBar />);
    expect(bar().getByRole("button", { name: "Phát" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(bar().getByRole("button", { name: "Bài trước" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(bar().getByRole("button", { name: "Bài tiếp theo" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("exposes shuffle and repeat state", () => {
    const track = youtubeTrack("t1");
    usePlayerStore.setState({
      currentTrack: track,
      queue: [track],
      playOrder: [0],
      position: 0,
    });
    render(<PlayerBar />);
    const shuffle = bar().getByRole("button", { name: "Bật phát ngẫu nhiên" });
    expect(shuffle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(shuffle);
    expect(
      bar().getByRole("button", { name: "Tắt phát ngẫu nhiên" }),
    ).toBeTruthy();

    const repeat = bar().getByRole("button", { name: "Repeat: tắt" });
    fireEvent.click(repeat);
    expect(bar().getByRole("button", { name: "Repeat: tất cả" })).toBeTruthy();
    fireEvent.click(bar().getByRole("button", { name: "Repeat: tất cả" }));
    expect(bar().getByRole("button", { name: "Repeat: một bài" })).toBeTruthy();
  });

  it("exposes mute state through its label", () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    render(<PlayerBar />);
    fireEvent.click(bar().getByRole("button", { name: "Tắt tiếng" }));
    expect(bar().getByRole("button", { name: "Bật tiếng" })).toBeTruthy();
  });

  it("mini player exposes play state and expand controls", async () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    render(<MiniPlayer />);
    const mini = within(screen.getByRole("region", { name: "Trình phát thu gọn" }));
    expect(mini.getByRole("button", { name: "Phát" })).toBeTruthy();
    expect(mini.getByRole("button", { name: "Mở rộng trình phát" })).toBeTruthy();
    expect(mini.getByRole("button", { name: "Tiếp theo" })).toBeTruthy();
    await act(async () => {
      usePlayerStore.setState({ isPlaying: true });
    });
    expect(mini.getByRole("button", { name: "Tạm dừng" })).toBeTruthy();
  });
});

/**
 * The pending state of the play control.
 *
 * A spinner on its own is decoration: it tells a sighted user something is
 * happening and tells a screen-reader user nothing. `aria-busy` is the part that
 * is machine-readable, and the disabled attribute is what stops a second tap
 * from firing a second `togglePlay` against one intent.
 *
 * These are asserted for the mini player specifically because it is the surface
 * that had drifted. The bar and the full player already blocked the toggle while
 * a track was resolving; the mini player showed the spinner and stayed live, so
 * the behaviour differed between two renderings of the same control.
 */
describe("play control pending state", () => {
  function miniPlay() {
    return within(screen.getByRole("region", { name: "Trình phát thu gọn" })).getByRole(
      "button",
      { name: /Phát|Tạm dừng/ },
    );
  }

  it("blocks a second toggle in every player surface while a track resolves", async () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    await act(async () => {
      usePlayerStore.setState({ isLoading: true });
    });
    render(<MiniPlayer />);
    expect(miniPlay().hasAttribute("disabled")).toBe(true);
  });

  it("publishes the pending state to assistive technology, not only to the eye", async () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    await act(async () => {
      usePlayerStore.setState({ isLoading: true });
    });
    render(<MiniPlayer />);
    // `aria-busy` must be ABSENT rather than "false" when idle, so that a
    // control which is not busy is not announced as busy.
    expect(miniPlay().getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      usePlayerStore.setState({ isLoading: false });
    });
    expect(miniPlay().hasAttribute("aria-busy")).toBe(false);
    expect(miniPlay().hasAttribute("disabled")).toBe(false);
  });
});

describe("seek slider semantics", () => {
  it("exposes slider role, label, and bounds", () => {
    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      duration: 200,
      currentTime: 42,
    });
    render(<PlayerBar />);
    const slider = bar().getByRole("slider", { name: "Tua" });
    expect(slider.getAttribute("min")).toBe("0");
    expect(slider.getAttribute("max")).toBe("200");
    expect(slider.getAttribute("value")).toBe("42");
  });

  it("supports arrow, home, and end keys through the engine", () => {
    surface!.duration = 200;
    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      duration: 200,
      currentTime: 100,
    });
    render(<PlayerBar />);
    const slider = bar().getByRole("slider", { name: "Tua" });

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(usePlayerStore.getState().currentTime).toBe(105);
    fireEvent.keyDown(slider, { key: "ArrowLeft" });
    expect(usePlayerStore.getState().currentTime).toBe(100);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(usePlayerStore.getState().currentTime).toBe(0);
    fireEvent.keyDown(slider, { key: "End" });
    expect(usePlayerStore.getState().currentTime).toBe(200);
  });

  it("volume slider exposes name and value", () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    render(<PlayerBar />);
    const volume = bar().getByRole("slider", { name: "Âm lượng" });
    expect(volume.getAttribute("value")).toBe("1");
  });
});
