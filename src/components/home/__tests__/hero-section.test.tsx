// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HeroSection } from "@/components/home/hero-section";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";

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
    expect(screen.getByRole("button", { name: "Play Hero Track" })).toBeTruthy();
  });

  it("starts playback when play button is clicked", async () => {
    const track = makePlayableTrack("t1", { title: "Hero Track" });
    render(<HeroSection track={track} />);
    fireEvent.click(screen.getByRole("button", { name: "Play Hero Track" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Play Hero Track" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pause Hero Track" })).toBeTruthy(),
    );
  });

  it("shows Featured label", () => {
    const track = makePlayableTrack("t1", { title: "Hero Track" });
    render(<HeroSection track={track} />);
    expect(screen.getByText("Featured")).toBeTruthy();
  });

  it("shows album name when available", () => {
    const track = makePlayableTrack("t1", { title: "Hero Track", albumName: "Hero Album" });
    render(<HeroSection track={track} />);
    expect(screen.getByText(/Hero Album/)).toBeTruthy();
  });
});
