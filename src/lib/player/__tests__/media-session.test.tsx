// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { setupMediaSession } from "@/lib/player/media-session";
import type { MediaSessionSeekDetails } from "@/lib/player/media-session";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";

type Handler = (details?: MediaSessionSeekDetails) => void;

interface FakeSession {
  metadata: unknown;
  playbackState: string;
  handlers: Map<string, Handler | null>;
  setCalls: Array<{ action: string; handler: Handler | null }>;
  positionCalls: Array<{ duration: number; playbackRate: number; position: number }>;
  throwOnAction: string | null;
  setActionHandler(action: string, handler: Handler | null): void;
  setPositionState?: (state: {
    duration: number;
    playbackRate: number;
    position: number;
  }) => void;
}

class FakeMetadata {
  init: unknown;
  constructor(init: unknown) {
    this.init = init;
  }
}

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  const session: FakeSession = {
    metadata: null,
    playbackState: "none",
    handlers: new Map(),
    setCalls: [],
    positionCalls: [],
    throwOnAction: null,
    setActionHandler(action: string, handler: Handler | null): void {
      if (session.throwOnAction === action) {
        throw new Error(`unsupported action ${action}`);
      }
      session.handlers.set(action, handler);
      session.setCalls.push({ action, handler });
    },
    setPositionState(state: {
      duration: number;
      playbackRate: number;
      position: number;
    }): void {
      session.positionCalls.push(state);
    },
    ...overrides,
  };
  return session;
}

function installMediaSession(session: FakeSession): void {
  Object.defineProperty(window.navigator, "mediaSession", {
    value: session,
    configurable: true,
    writable: true,
  });
}

function removeMediaSession(): void {
  const nav = window.navigator as unknown as Record<string, unknown>;
  if ("mediaSession" in nav) {
    delete nav.mediaSession;
  }
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

function youtubeTrack(id: string, overrides: Record<string, unknown> = {}) {
  return makePlayableTrack(id, {
    provider: "youtube",
    providerTrackId: id,
    title: `Title ${id}`,
    artistName: "Artist",
    albumName: "Album",
    artworkUrl: `https://art.example/${id}.jpg`,
    // A resolved stream URL must never leak into metadata artwork.
    streamUrl: `https://evil.example/${id}.mp3`,
    ...overrides,
  });
}

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

let unmountFacade: (() => void) | undefined;
let engineDispose: (() => void) | undefined;

beforeEach(() => {
  resetStore();
  removeMediaSession();
  vi.stubGlobal("MediaMetadata", FakeMetadata);
});

afterEach(() => {
  cleanup();
  unmountFacade?.();
  unmountFacade = undefined;
  engineDispose?.();
  engineDispose = undefined;
  usePlayerStore.getState().bindEngine(null);
  removeMediaSession();
  vi.unstubAllGlobals();
});

function mountEngine(): FakeAudioSurface {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  engineDispose = usePlayerStore.getState().bindEngine(engine);
  return surface;
}

function metadataInit(session: FakeSession): Record<string, unknown> {
  expect(session.metadata).toBeInstanceOf(FakeMetadata);
  return (session.metadata as FakeMetadata).init as Record<string, unknown>;
}

describe("media session metadata", () => {
  it("publishes title, artist, album, and artwork on track load", () => {
    const session = fakeSession();
    installMediaSession(session);
    const teardown = setupMediaSession(usePlayerStore.getState);

    usePlayerStore.setState({
      queue: [youtubeTrack("t1")],
      playOrder: [0],
      position: 0,
      currentTrack: youtubeTrack("t1"),
    });

    expect(metadataInit(session)).toMatchObject({
      title: "Title t1",
      artist: "Artist",
      album: "Album",
    });
    const artwork = (metadataInit(session).artwork ?? []) as Array<{
      src: string;
    }>;
    expect(artwork.length).toBeGreaterThan(0);
    for (const entry of artwork) {
      expect(entry.src).toBe("https://art.example/t1.jpg");
    }
    teardown?.();
  });

  it("uses an empty artwork list when artwork is missing", () => {
    const session = fakeSession();
    installMediaSession(session);
    const teardown = setupMediaSession(usePlayerStore.getState);

    usePlayerStore.setState({ currentTrack: youtubeTrack("t1", { artworkUrl: undefined }) });

    expect(metadataInit(session)).toMatchObject({ artwork: [] });
    teardown?.();
  });

  it("updates metadata on track change and clears it when stopped", () => {
    const session = fakeSession();
    installMediaSession(session);
    const teardown = setupMediaSession(usePlayerStore.getState);

    usePlayerStore.setState({ currentTrack: youtubeTrack("a") });
    expect(metadataInit(session)).toMatchObject({ title: "Title a" });
    usePlayerStore.setState({ currentTrack: youtubeTrack("b") });
    expect(metadataInit(session)).toMatchObject({ title: "Title b" });

    usePlayerStore.getState().clearQueue();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    teardown?.();
  });
});

describe("media session playback state", () => {
  it("maps playing, paused, and empty states", () => {
    const session = fakeSession();
    installMediaSession(session);
    const teardown = setupMediaSession(usePlayerStore.getState);

    expect(session.playbackState).toBe("none");
    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      isPlaying: true,
    });
    expect(session.playbackState).toBe("playing");
    usePlayerStore.setState({ isPlaying: false });
    expect(session.playbackState).toBe("paused");
    teardown?.();
  });
});

describe("media session position state", () => {
  it("writes valid clamped position state and skips invalid values", () => {
    const session = fakeSession();
    installMediaSession(session);
    const teardown = setupMediaSession(usePlayerStore.getState);

    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      duration: 200,
      currentTime: 42,
    });
    expect(session.positionCalls).toEqual([
      { duration: 200, playbackRate: 1, position: 42 },
    ]);

    // Identical syncs must not rewrite (change-gated, ~1Hz cadence).
    usePlayerStore.setState({ currentTime: 42 });
    expect(session.positionCalls).toHaveLength(1);

    // Beyond-duration positions clamp instead of leaking invalid values.
    usePlayerStore.setState({ currentTime: 500 });
    expect(session.positionCalls.at(-1)).toEqual({
      duration: 200,
      playbackRate: 1,
      position: 200,
    });
    teardown?.();
  });

  it("never writes position state without a finite duration", () => {
    const session = fakeSession();
    installMediaSession(session);
    const teardown = setupMediaSession(usePlayerStore.getState);

    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      duration: 0,
      currentTime: 10,
    });
    expect(session.positionCalls).toEqual([]);
    teardown?.();
  });

  it("works when setPositionState is unavailable", () => {
    const session = fakeSession({ setPositionState: undefined });
    installMediaSession(session);
    expect(() =>
      setupMediaSession(usePlayerStore.getState),
    ).not.toThrow();
    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      duration: 200,
      currentTime: 10,
    });
    expect(session.playbackState).toBe("paused");
  });
});

describe("media session action handlers", () => {
  function setupWithEngine() {
    unmountFacade = mountTestFacade();
    const surface = mountEngine();
    const session = fakeSession();
    installMediaSession(session);
    const teardown = setupMediaSession(usePlayerStore.getState);
    return { surface, session, teardown };
  }

  it("registers every owned action exactly once", () => {
    const { session, teardown } = setupWithEngine();
    for (const action of [
      "play",
      "pause",
      "previoustrack",
      "nexttrack",
      "seekbackward",
      "seekforward",
      "seekto",
    ]) {
      expect(session.handlers.get(action), action).toBeTypeOf("function");
    }
    teardown?.();
  });

  it("routes play through the facade until the element plays", async () => {
    const { session } = setupWithEngine();
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    session.handlers.get("play")?.({});
    await flush();
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("routes pause through the facade", () => {
    const { session } = setupWithEngine();
    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      isPlaying: true,
    });
    session.handlers.get("pause")?.({});
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("routes next and previous through queue semantics", () => {
    const { session } = setupWithEngine();
    usePlayerStore.getState().replaceQueue([youtubeTrack("a"), youtubeTrack("b")]);
    session.handlers.get("nexttrack")?.({});
    expect(usePlayerStore.getState().currentTrack?.id).toBe("b");
    session.handlers.get("previoustrack")?.({});
    expect(usePlayerStore.getState().currentTrack?.id).toBe("a");
  });

  it("routes seeks with default and explicit offsets", () => {
    const { surface, session } = setupWithEngine();
    surface.duration = 200;
    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      currentTime: 100,
    });

    session.handlers.get("seekforward")?.({});
    expect(usePlayerStore.getState().currentTime).toBe(110);
    session.handlers.get("seekbackward")?.({ seekOffset: 5 });
    expect(usePlayerStore.getState().currentTime).toBe(105);
    session.handlers.get("seekto")?.({ seekTime: 30 });
    expect(usePlayerStore.getState().currentTime).toBe(30);
  });

  it("ignores invalid seek requests without throwing", () => {
    const { session } = setupWithEngine();
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    expect(() => {
      session.handlers.get("seekto")?.({});
      session.handlers.get("seekto")?.({ seekTime: Number.NaN });
      session.handlers.get("seekto")?.({ seekTime: -5 });
      session.handlers.get("nexttrack")?.({});
    }).not.toThrow();
  });
});

describe("media session lifecycle", () => {
  it("removes exactly the owned handlers on teardown and stops syncing", () => {
    const session = fakeSession();
    installMediaSession(session);
    const teardown = setupMediaSession(usePlayerStore.getState);
    expect(teardown).toBeTypeOf("function");

    teardown?.();
    const cleared = session.setCalls
      .filter((call) => call.handler === null)
      .map((call) => call.action)
      .sort();
    expect(cleared).toEqual(
      [
        "nexttrack",
        "pause",
        "play",
        "previoustrack",
        "seekbackward",
        "seekforward",
        "seekto",
      ].sort(),
    );

    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });
    expect(session.metadata).toBeNull();
  });

  it("remounts with exactly one active subscription", () => {
    const session = fakeSession();
    installMediaSession(session);
    const first = setupMediaSession(usePlayerStore.getState);
    first?.();

    const before = session.setCalls.length;
    const second = setupMediaSession(usePlayerStore.getState);
    usePlayerStore.setState({ currentTrack: youtubeTrack("t1") });

    const registrations = session.setCalls
      .slice(before)
      .filter((call) => call.handler !== null);
    expect(registrations).toHaveLength(7);
    expect(metadataInit(session)).toMatchObject({ title: "Title t1" });
    second?.();
  });

  it("is a no-op without Media Session support", () => {
    removeMediaSession();
    expect(() => setupMediaSession(usePlayerStore.getState)).not.toThrow();
    expect(setupMediaSession(usePlayerStore.getState)).toBeUndefined();
  });

  it("survives unsupported actions and missing metadata constructor", () => {
    const session = fakeSession({ throwOnAction: "seekto" });
    installMediaSession(session);
    vi.stubGlobal("MediaMetadata", undefined);
    const teardown = setupMediaSession(usePlayerStore.getState);

    const registered = [...session.handlers.keys()].sort();
    expect(registered).toEqual(
      ["nexttrack", "pause", "play", "previoustrack", "seekbackward", "seekforward"].sort(),
    );
    // Playback state still synchronizes without metadata support.
    usePlayerStore.setState({
      currentTrack: youtubeTrack("t1"),
      isPlaying: true,
    });
    expect(session.playbackState).toBe("playing");
    teardown?.();
  });
});
