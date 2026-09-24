// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { usePlayerStore } from "@/lib/player/store";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";
import { getMusicEngine } from "@/lib/music/instance";
import {
  useMusicEngine,
  useMusicEngineState,
} from "@/lib/music/use-music-engine";

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

function EngineLabel() {
  const engine = useMusicEngine();
  return <div>{engine ? "mounted" : "missing"}</div>;
}

function ErrorLabel() {
  const error = useMusicEngineState((s) => s.error);
  return <div>{error ? error.message : "no error"}</div>;
}

function PlayingLabel() {
  const isPlaying = useMusicEngineState((s) => s.isPlaying);
  return <div>{isPlaying ? "playing" : "paused"}</div>;
}

describe("useMusicEngine", () => {
  afterEach(() => {
    cleanup();
  });

  it("is null with no mounted engine and renders the empty snapshot", () => {
    resetStore();
    expect(getMusicEngine()).toBeNull();
    render(<EngineLabel />);
    expect(screen.getByText("missing")).toBeTruthy();
    render(<PlayingLabel />);
    expect(screen.getByText("paused")).toBeTruthy();
  });

  it("renders on the server without a mounted engine", () => {
    resetStore();
    expect(() => renderToString(<PlayingLabel />)).not.toThrow();
    expect(renderToString(<PlayingLabel />)).toContain("paused");
  });

  it("follows mount and unmount of the facade", () => {
    resetStore();
    const { unmount } = render(<EngineLabel />);
    expect(screen.getByText("missing")).toBeTruthy();

    let unmountFacade: (() => void) | undefined;
    act(() => {
      unmountFacade = mountTestFacade();
    });
    expect(screen.getByText("mounted")).toBeTruthy();

    act(() => {
      unmountFacade?.();
    });
    expect(screen.getByText("missing")).toBeTruthy();
    unmount();
  });

  it("re-renders when the selected slice changes", async () => {
    resetStore();
    const unmountFacade = mountTestFacade();
    try {
      render(<PlayingLabel />);
      expect(screen.getByText("paused")).toBeTruthy();
      await act(async () => {
        usePlayerStore.setState({ isPlaying: true });
      });
      expect(screen.getByText("playing")).toBeTruthy();
    } finally {
      unmountFacade();
    }
  });

  it("keeps a stable error reference across unrelated updates", async () => {
    resetStore();
    const unmountFacade = mountTestFacade();
    try {
      let renders = 0;
      function Probe() {
        const error = useMusicEngineState((s) => s.error);
        useEffect(() => {
          renders += 1;
        });
        return <div>{error ? error.message : "no error"}</div>;
      }
      render(<Probe />);
      const baseline = renders;
      await act(async () => {
        usePlayerStore.setState({
          error: { kind: "playback", message: "boom" },
        });
      });
      expect(screen.getByText("boom")).toBeTruthy();
      const withError = renders;
      expect(withError).toBeGreaterThan(baseline);

      // Unrelated updates must not produce a fresh error object: a new
      // reference per snapshot loops useSyncExternalStore forever.
      await act(async () => {
        usePlayerStore.setState({ volume: 0.5 });
      });
      expect(renders).toBe(withError);
      expect(getMusicEngine()?.getState().error).toBe(
        getMusicEngine()?.getState().error,
      );
    } finally {
      unmountFacade();
    }
  });

  it("selects the error label", () => {
    resetStore();
    const unmountFacade = mountTestFacade();
    try {
      render(<ErrorLabel />);
      expect(screen.getByText("no error")).toBeTruthy();
    } finally {
      unmountFacade();
    }
  });

  it("rerenders only the slices a selector reads", async () => {
    // Phase 22 regression guard: a volume/position change must not
    // rerender a track-only subscriber, while a track change must.
    resetStore();
    const unmountFacade = mountTestFacade();
    try {
      let renders = 0;
      function TrackProbe() {
        const track = useMusicEngineState((s) => s.currentTrack);
        useEffect(() => {
          renders += 1;
        });
        return <div>{track ? track.title : "no track"}</div>;
      }
      render(<TrackProbe />);
      const baseline = renders;
      await act(async () => {
        usePlayerStore.setState({ volume: 0.5, currentTime: 12 });
      });
      expect(renders).toBe(baseline);
      await act(async () => {
        usePlayerStore.setState({
          currentTrack: {
            id: "t1",
            provider: "youtube",
            providerTrackId: "t1",
            title: "Song",
            artistId: "a1",
            artistName: "Artist",
          },
        });
      });
      expect(screen.getByText("Song")).toBeTruthy();
      expect(renders).toBeGreaterThan(baseline);
    } finally {
      unmountFacade();
    }
  });
});
