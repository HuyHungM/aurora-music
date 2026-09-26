// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TrackRow } from "@/components/tracks/track-row";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  createPlaylistAction: vi.fn().mockResolvedValue({ ok: true, playlistId: "new" }),
}));

let unmountFacade: (() => void) | undefined;

describe("TrackRow with collection context", () => {
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

  it("calls playCollection with correct index when collectionTracks is provided", () => {
    const track1 = makePlayableTrack("t1", { title: "Track 1", artistName: "Artist 1" });
    const track2 = makePlayableTrack("t2", { title: "Track 2", artistName: "Artist 2" });
    const track3 = makePlayableTrack("t3", { title: "Track 3", artistName: "Artist 3" });
    const collectionTracks = [track1, track2, track3];

    render(
      <TrackRow
        track={track2}
        collectionTracks={collectionTracks}
        collectionIndex={1}
        showMenu={true}
        showAddToPlaylist={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Phát Track 2" }));

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("t2");
    expect(state.queue.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(state.position).toBe(1);
  });

  it("calls playCollection at index 0 for first track", () => {
    const track1 = makePlayableTrack("t1", { title: "Track 1", artistName: "Artist 1" });
    const track2 = makePlayableTrack("t2", { title: "Track 2", artistName: "Artist 2" });
    const collectionTracks = [track1, track2];

    render(
      <TrackRow
        track={track1}
        collectionTracks={collectionTracks}
        collectionIndex={0}
        showMenu={true}
        showAddToPlaylist={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Phát Track 1" }));

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("t1");
    expect(state.position).toBe(0);
  });

  it("calls playCollection at last index for last track", () => {
    const track1 = makePlayableTrack("t1", { title: "Track 1", artistName: "Artist 1" });
    const track2 = makePlayableTrack("t2", { title: "Track 2", artistName: "Artist 2" });
    const collectionTracks = [track1, track2];

    render(
      <TrackRow
        track={track2}
        collectionTracks={collectionTracks}
        collectionIndex={1}
        showMenu={true}
        showAddToPlaylist={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Phát Track 2" }));

    const state = usePlayerStore.getState();
    expect(state.currentTrack?.id).toBe("t2");
    expect(state.position).toBe(1);
  });

  it("shows remove button when onRemoveFromPlaylist is provided", () => {
    const track = makePlayableTrack("t1", { title: "Track 1", artistName: "Artist 1" });
    const onRemove = vi.fn();

    render(
      <TrackRow
        track={track}
        showMenu={true}
        showAddToPlaylist={false}
        onRemoveFromPlaylist={onRemove}
      />,
    );

    expect(screen.getByRole("button", { name: "Xóa Track 1 khỏi playlist" })).toBeTruthy();
  });

  it("hides remove button when onRemoveFromPlaylist is not provided", () => {
    const track = makePlayableTrack("t1", { title: "Track 1", artistName: "Artist 1" });

    render(
      <TrackRow track={track} showMenu={true} showAddToPlaylist={false} />,
    );

    expect(screen.queryByRole("button", { name: "Xóa Track 1 khỏi playlist" })).toBeNull();
  });

  it("calls onRemoveFromPlaylist when remove button is clicked", () => {
    const track = makePlayableTrack("t1", { title: "Track 1", artistName: "Artist 1" });
    const onRemove = vi.fn();

    render(
      <TrackRow
        track={track}
        showMenu={true}
        showAddToPlaylist={false}
        onRemoveFromPlaylist={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Xóa Track 1 khỏi playlist" }));

    expect(onRemove).toHaveBeenCalledOnce();
  });
});

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
  });
}

describe("TrackRow", () => {
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

  it("starts playback when its play button is pressed", async () => {
    const track = makePlayableTrack("t1", { artistName: "Row Artist" });
    render(<TrackRow track={track} />);

    fireEvent.click(screen.getByRole("button", { name: "Phát Track t1" }));
    await waitFor(() => {
      const state = usePlayerStore.getState();
      expect(state.currentTrack?.id).toBe("t1");
      expect(state.queue.map((t) => t.id)).toEqual(["t1"]);
    });
  });

  it("becomes a pause control while the track is playing", async () => {
    const track = makePlayableTrack("t1", {
      artistName: "Row Artist",
      provider: "youtube",
      providerTrackId: "t1",
    });
    render(<TrackRow track={track} />);

    fireEvent.click(screen.getByRole("button", { name: "Phát Track t1" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Tạm dừng Track t1" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Tạm dừng Track t1" }));
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(screen.getByRole("button", { name: "Phát Track t1" })).toBeTruthy();
  });

  it("keeps separate rows for the same id across providers", async () => {
    const jamendo = makePlayableTrack("s1", { title: "Jamendo pick", provider: "jamendo" });
    const mock = makePlayableTrack("s1", { title: "Mock pick", provider: "mock" });

    const { unmount } = render(
      <>
        <TrackRow track={jamendo} />
        <TrackRow track={mock} />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Phát Jamendo pick" }));
    await waitFor(() =>
      expect(usePlayerStore.getState().currentTrack?.provider).toBe("jamendo"),
    );

    // playTrack replaces the queue; clicking the second track replaces with just that track
    fireEvent.click(screen.getByRole("button", { name: "Phát Mock pick" }));
    await waitFor(() => {
      const state = usePlayerStore.getState();
      expect(state.currentTrack?.provider).toBe("mock");
      expect(state.queue.map((t) => t.id)).toEqual(["s1"]);
    });

    unmount();
  });
});