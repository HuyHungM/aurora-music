// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import {
  EventEnum,
  FakeAudioSurface,
  makePlayableTrack,
} from "@/lib/player/__tests__/fake-audio";

const mocks = vi.hoisted(() => ({
  getDefaultEngine: vi.fn(),
  getPlaybackStateAction: vi.fn(),
  savePlaybackStateAction: vi.fn(),
  clearPlaybackStateAction: vi.fn(),
  getSessionUserIdAction: vi.fn(),
  resolvePlaybackTrackAction: vi.fn(),
}));

vi.mock("@/lib/player/engine-factory", () => ({
  getDefaultEngine: mocks.getDefaultEngine,
}));

vi.mock("@/app/actions/playback", () => ({
  recordPlayedAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/app/actions/playback-state", () => ({
  getPlaybackStateAction: mocks.getPlaybackStateAction,
  savePlaybackStateAction: mocks.savePlaybackStateAction,
  clearPlaybackStateAction: mocks.clearPlaybackStateAction,
  getSessionUserIdAction: mocks.getSessionUserIdAction,
  resolvePlaybackTrackAction: mocks.resolvePlaybackTrackAction,
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
    persistenceInitState: "idle",
    userActionGeneration: 0,
    pendingRestorePosition: null,
    qualifiedTrackKey: null,
  });
}

describe("PlayerHost authenticated persistence", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    const surface = new FakeAudioSurface();
    const engine = new PlayerEngine(surface);
    mocks.getDefaultEngine.mockReturnValue(engine);
    mocks.getPlaybackStateAction.mockResolvedValue({ ok: true, state: null });
    mocks.savePlaybackStateAction.mockResolvedValue({ ok: true });
    mocks.clearPlaybackStateAction.mockResolvedValue({ ok: true });
    mocks.getSessionUserIdAction.mockResolvedValue({
      ok: true,
      userId: null,
    });
    mocks.resolvePlaybackTrackAction.mockResolvedValue({
      ok: true,
      track: null,
    });
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().bindEngine(null);
  });

  it("anonymous startup marks persistence ready without fetching", async () => {
    render(<PlayerHost />);
    await waitFor(() =>
      expect(usePlayerStore.getState().persistenceInitState).toBe("ready"),
    );
    expect(mocks.getPlaybackStateAction).not.toHaveBeenCalled();
    expect(mocks.resolvePlaybackTrackAction).not.toHaveBeenCalled();
  });

  it("authenticated startup restores track and safe position", async () => {
    mocks.getSessionUserIdAction.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "t-restore",
        position: 83,
        revision: 4,
        updatedAt: new Date().toISOString(),
      },
    });
    const restored = makePlayableTrack("t-restore", {
      title: "Restored Track",
    });
    mocks.resolvePlaybackTrackAction.mockResolvedValue({
      ok: true,
      track: restored,
    });

    render(<PlayerHost />);

    await waitFor(() =>
      expect(usePlayerStore.getState().currentTrack?.id).toBe("t-restore"),
    );
    expect(usePlayerStore.getState().persistenceInitState).toBe("ready");
    // No autoplay on restore.
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().pendingRestorePosition).toBe(83);
  });

  it("continues startup when provider resolution fails", async () => {
    mocks.getSessionUserIdAction.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "gone",
        position: 10,
        revision: 1,
        updatedAt: new Date().toISOString(),
      },
    });
    mocks.resolvePlaybackTrackAction.mockResolvedValue({
      ok: true,
      track: null,
    });

    render(<PlayerHost />);

    await waitFor(() =>
      expect(usePlayerStore.getState().persistenceInitState).toBe("ready"),
    );
    expect(mocks.clearPlaybackStateAction).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().currentTrack).toBeNull();
  });

  it("user playback during restore wins over the restore", async () => {
    let resolveFetch!: (
      value:
        | { ok: true; state: null }
        | {
            ok: true;
            state: {
              provider: string;
              providerTrackId: string;
              position: number;
              revision: number;
              updatedAt: string;
            };
          },
    ) => void;
    const fetchGate = new Promise<
      | { ok: true; state: null }
      | {
          ok: true;
          state: {
            provider: string;
            providerTrackId: string;
            position: number;
            revision: number;
            updatedAt: string;
          };
        }
    >((res) => {
      resolveFetch = res;
    });
    mocks.getSessionUserIdAction.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mocks.getPlaybackStateAction.mockReturnValue(fetchGate);
    mocks.resolvePlaybackTrackAction.mockResolvedValue({
      ok: true,
      track: makePlayableTrack("t-restore"),
    });

    render(<PlayerHost />);
    await waitFor(() =>
      expect(mocks.getPlaybackStateAction).toHaveBeenCalled(),
    );

    // User acts while restore is in flight.
    usePlayerStore.getState().playTrack(makePlayableTrack("user-A"));

    resolveFetch({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "t-restore",
        position: 50,
        revision: 1,
        updatedAt: new Date().toISOString(),
      },
    });

    await waitFor(() =>
      expect(usePlayerStore.getState().persistenceInitState).toBe("ready"),
    );
    expect(usePlayerStore.getState().currentTrack?.id).toBe("user-A");
  });

  it("restores the full queue with cursor, shuffle, and repeat intact", async () => {
    mocks.getSessionUserIdAction.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "t-b",
        position: 34,
        revision: 2,
        updatedAt: new Date().toISOString(),
        queueSnapshot: {
          version: 2,
          entries: [
            {
              provider: "mock",
              providerTrackId: "t-a",
              title: "Track A",
              artistId: "a1",
              artistName: "Artist",
            },
            {
              provider: "mock",
              providerTrackId: "t-b",
              title: "Track B",
              artistId: "a1",
              artistName: "Artist",
            },
          ],
          playOrder: [1, 0],
          position: 0,
          mediaPosition: 34,
          shuffle: true,
          repeat: "all",
          volume: 0.75,
          muted: false,
          savedAt: 1_700_000_000_000,
        },
      },
    });
    mocks.resolvePlaybackTrackAction.mockResolvedValue({
      ok: true,
      track: makePlayableTrack("t-b", { title: "Track B fresh" }),
    });

    render(<PlayerHost />);

    await waitFor(() =>
      expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual([
        "t-a",
        "t-b",
      ]),
    );
    const state = usePlayerStore.getState();
    expect(state.playOrder).toEqual([1, 0]);
    expect(state.position).toBe(0);
    expect(state.shuffle).toBe(true);
    expect(state.repeat).toBe("all");
    expect(state.currentTrack?.title).toBe("Track B fresh");
    expect(state.pendingRestorePosition).toBe(34);
    // Restored, not playing: no autoplay on restore.
    expect(state.isPlaying).toBe(false);
    // The restored queue is live: navigation works immediately.
    state.next();
    expect(usePlayerStore.getState().currentTrack?.id).toBe("t-a");
  });

  it("seek on restore applies once metadata loads", async () => {
    const surface = new FakeAudioSurface();
    const engine = new PlayerEngine(surface);
    mocks.getDefaultEngine.mockReturnValue(engine);
    mocks.getSessionUserIdAction.mockResolvedValue({
      ok: true,
      userId: "user-1",
    });
    mocks.getPlaybackStateAction.mockResolvedValue({
      ok: true,
      state: {
        provider: "mock",
        providerTrackId: "t-restore",
        position: 40,
        revision: 2,
        updatedAt: new Date().toISOString(),
      },
    });
    mocks.resolvePlaybackTrackAction.mockResolvedValue({
      ok: true,
      track: makePlayableTrack("t-restore"),
    });

    render(<PlayerHost />);
    await waitFor(() =>
      expect(usePlayerStore.getState().currentTrack?.id).toBe("t-restore"),
    );

    surface.duration = 200;
    surface.dispatch(EventEnum.loadedmetadata);

    await waitFor(() =>
      expect(usePlayerStore.getState().currentTime).toBe(40),
    );
    expect(screen.getByRole("region", { name: "Thanh phát nhạc" })).toBeTruthy();
  });
});
