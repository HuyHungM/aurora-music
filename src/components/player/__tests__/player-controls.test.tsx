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
  return within(screen.getByRole("region", { name: "Player bar" }));
}

describe("player control names and states", () => {
  it("exposes play state through the accessible name", async () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    render(<PlayerBar />);
    expect(bar().getByRole("button", { name: "Play" })).toBeTruthy();
    await act(async () => {
      usePlayerStore.setState({ isPlaying: true });
    });
    expect(bar().getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("disables transport controls without a track", () => {
    render(<PlayerBar />);
    expect(bar().getByRole("button", { name: "Play" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(bar().getByRole("button", { name: "Previous track" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(bar().getByRole("button", { name: "Next track" })).toHaveProperty(
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
    const shuffle = bar().getByRole("button", { name: "Enable shuffle" });
    expect(shuffle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(shuffle);
    expect(
      bar().getByRole("button", { name: "Disable shuffle" }),
    ).toBeTruthy();

    const repeat = bar().getByRole("button", { name: "Repeat: off" });
    fireEvent.click(repeat);
    expect(bar().getByRole("button", { name: "Repeat: all" })).toBeTruthy();
    fireEvent.click(bar().getByRole("button", { name: "Repeat: all" }));
    expect(bar().getByRole("button", { name: "Repeat: one" })).toBeTruthy();
  });

  it("exposes mute state through its label", () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    render(<PlayerBar />);
    fireEvent.click(bar().getByRole("button", { name: "Mute" }));
    expect(bar().getByRole("button", { name: "Unmute" })).toBeTruthy();
  });

  it("mini player exposes play state and expand controls", async () => {
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    render(<MiniPlayer />);
    const mini = within(screen.getByRole("region", { name: "Mini player" }));
    expect(mini.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(mini.getByRole("button", { name: "Expand player" })).toBeTruthy();
    expect(mini.getByRole("button", { name: "Up next" })).toBeTruthy();
    await act(async () => {
      usePlayerStore.setState({ isPlaying: true });
    });
    expect(mini.getByRole("button", { name: "Pause" })).toBeTruthy();
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
    const slider = bar().getByRole("slider", { name: "Seek" });
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
    const slider = bar().getByRole("slider", { name: "Seek" });

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
    const volume = bar().getByRole("slider", { name: "Volume" });
    expect(volume.getAttribute("value")).toBe("1");
  });
});
