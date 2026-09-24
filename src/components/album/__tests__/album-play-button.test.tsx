// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { AlbumPlayButton } from "@/components/album/album-play-button";
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

describe("AlbumPlayButton", () => {
  it("renders play button with correct label", () => {
    render(<AlbumPlayButton tracks={[makeTrack("t1")]} />);
    expect(screen.getByRole("button", { name: "Play album" })).toBeTruthy();
  });

  it("renders Play text", () => {
    render(<AlbumPlayButton tracks={[makeTrack("t1")]} />);
    expect(screen.getByText("Play")).toBeTruthy();
  });

  it("calls playCollection with all tracks when clicked", async () => {
    const user = userEvent.setup();
    const tracks = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    render(<AlbumPlayButton tracks={tracks} />);

    await user.click(screen.getByRole("button", { name: "Play album" }));

    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(state.position).toBe(0);
  });

  it("plays from specific track when clicked with startIndex", async () => {
    const user = userEvent.setup();
    const tracks = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    render(<AlbumPlayButton tracks={tracks} />);

    await user.click(screen.getByRole("button", { name: "Play album" }));

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("t1");
    expect(state.position).toBe(0);
  });

  it("replaces existing queue", async () => {
    const user = userEvent.setup();
    usePlayerStore.setState({
      queue: [makeTrack("old")],
      playOrder: [0],
      position: 0,
      currentTrack: makeTrack("old"),
    });

    const tracks = [makeTrack("t1"), makeTrack("t2")];
    render(<AlbumPlayButton tracks={tracks} />);

    await user.click(screen.getByRole("button", { name: "Play album" }));

    const state = usePlayerStore.getState();
    expect(state.queue.map((t) => t.id)).toEqual(["t1", "t2"]);
  });
});
