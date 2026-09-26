// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { LibraryPlayButton } from "@/components/library/library-play-button";
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

describe("LibraryPlayButton", () => {
  it("renders play button with correct label", () => {
    render(<LibraryPlayButton tracks={[makeTrack("t1")]} labelKey="library.playLiked" />);
    expect(screen.getByRole("button", { name: "Phát nhạc đã thích" })).toBeTruthy();
  });

  it("renders Play text", () => {
    render(<LibraryPlayButton tracks={[makeTrack("t1")]} labelKey="library.playLiked" />);
    expect(screen.getByText("Phát")).toBeTruthy();
  });

  it("calls playCollection with all tracks when clicked", async () => {
    const user = userEvent.setup();
    const tracks = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    render(<LibraryPlayButton tracks={tracks} labelKey="library.playRecent" />);

    await user.click(screen.getByRole("button", { name: "Phát mới nghe" }));

    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(state.position).toBe(0);
  });

  it("does nothing when tracks array is empty", async () => {
    const user = userEvent.setup();
    render(<LibraryPlayButton tracks={[]} labelKey="library.playLiked" />);

    await user.click(screen.getByRole("button", { name: "Phát nhạc đã thích" }));

    const state = usePlayerStore.getState();
    expect(state.queue).toEqual([]);
  });
});
