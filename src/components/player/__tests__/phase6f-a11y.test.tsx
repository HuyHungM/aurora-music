// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { usePlayerStore } from "@/lib/player/store";

vi.mock("@/lib/player/engine-factory", () => ({
  getDefaultEngine: () => ({
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

vi.mock("@/app/actions/playback", () => ({
  recordPlayedAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { MiniPlayer } from "@/components/player/mini-player";
import { QueuePanel } from "@/components/player/queue-panel";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";

function makeTrack(id: string) {
  return {
    id,
    provider: "youtube" as const,
    providerTrackId: `youtube-${id}`,
    title: `Track ${id}`,
    artistId: "a1",
    artistName: "Test Artist",
    streamUrl: `https://example.com/${id}.mp3`,
  };
}

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
    isFullPlayerOpen: false,
    qualifiedTrackKey: null,
    duration: 0,
    currentTime: 0,
  });
});

describe("Phase 6F accessibility and touch target fixes", () => {
  describe("MiniPlayer touch targets", () => {
    it("repeat button meets 44px minimum", () => {
      usePlayerStore.setState({ currentTrack: makeTrack("1") });
      render(<MiniPlayer />);
      const btn = screen.getByRole("button", { name: /repeat/i });
      expect(btn.className).toContain("h-11");
      expect(btn.className).toContain("w-11");
    });

    it("queue button meets 44px minimum", () => {
      usePlayerStore.setState({ currentTrack: makeTrack("1") });
      render(<MiniPlayer />);
      const btn = screen.getByRole("button", { name: "Up next" });
      expect(btn.className).toContain("h-11");
      expect(btn.className).toContain("w-11");
    });

    it("play button meets 44px minimum", () => {
      usePlayerStore.setState({ currentTrack: makeTrack("1") });
      render(<MiniPlayer />);
      const btn = screen.getByRole("button", { name: "Play" });
      expect(btn.className).toContain("h-11");
      expect(btn.className).toContain("w-11");
    });
  });

  describe("QueuePanel close button", () => {
    it("close button meets 44px minimum", () => {
      usePlayerStore.setState({
        currentTrack: makeTrack("1"),
        queue: [makeTrack("1")],
        playOrder: [0],
        position: 0,
        isQueueOpen: true,
      });
      render(<QueuePanel />);
      const btn = screen.getByRole("button", { name: "Close queue" });
      expect(btn.className).toContain("h-11");
      expect(btn.className).toContain("w-11");
    });
  });

  describe("QueueItemMenu aria-label", () => {
    it("includes track title in aria-label", () => {
      usePlayerStore.setState({
        currentTrack: makeTrack("current"),
        queue: [makeTrack("current"), makeTrack("other")],
        playOrder: [0, 1],
        position: 0,
        isQueueOpen: true,
      });
      render(<QueuePanel />);
      const menuBtn = screen.getByRole("button", { name: "Actions for Track other" });
      expect(menuBtn).toBeTruthy();
    });
  });
});
