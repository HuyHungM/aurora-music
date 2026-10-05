// @vitest-environment jsdom
/**
 * Offline local playback: the actual audio bytes, with no network.
 *
 * WHAT THIS IS NOT. It is not a test that the app shell loads from a service
 * worker cache. Everything here runs the SHIPPING chain a local file goes
 * through in production:
 *
 *   local Track -> store -> PlaybackController -> PlaybackResolver registry
 *               -> createLocalSourceResolver -> File -> object URL
 *               -> PlayerEngine -> media element
 *
 * The resolver registry is wired exactly as `PlayerHost` wires it: the server
 * resolver FIRST and the local resolver after it, so a local track is only
 * resolved locally because the registry genuinely dispatches on source type.
 * That server resolver is ARMED, not stubbed away: it records every call and
 * throws a realistic `Failed to fetch`. So "no network" is proven by the network
 * path being reachable and never taken, not by making every request fail
 * (which would also make a suite that wrongly used the network pass).
 *
 * `navigator.onLine` is false for the whole file, so anything that consults
 * connectivity is exercised against a genuinely offline browser.
 *
 * Object URLs are the one browser primitive that cannot run here, so
 * create/revoke are recorded exactly as `local-resolver.test.ts` records them;
 * every other line is production code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/lib/domain";
import { PlayerEngine } from "@/lib/player/engine";
import {
  remainingQueue,
  resetUnavailableSkipGuardForTests,
  setPlaybackController,
  setRecordPlayedAction,
  usePlayerStore,
} from "@/lib/player/store";
import { createPlaybackController } from "@/lib/playback/controller";
import { createPlaybackResolver } from "@/lib/playback/resolver";
import { createServerSourceResolver } from "@/lib/playback/client-resolver";
import { createLocalSourceResolver } from "@/lib/offline/local-resolver";
import {
  replaceFileRegistry,
  resetOfflineSession,
  liveObjectUrlCount,
} from "@/lib/offline/session";
import { localTrack } from "@/lib/offline/tracks";
import type { OfflineFileHandle } from "@/lib/offline/types";
import { EventEnum, FakeAudioSurface } from "./fake-audio";

/** Microtasks only: no timers, no real waits, nothing time-dependent. */
async function flush(): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    await Promise.resolve();
  }
}

const created: string[] = [];
const revoked: string[] = [];
let urlCounter = 0;

function installUrlFakes(): void {
  urlCounter = 0;
  created.length = 0;
  revoked.length = 0;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => {
      urlCounter += 1;
      const url = `blob:offline-${urlCounter}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
}

function goOffline(): void {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => false,
  });
}

/** A local file the browser can actually open, exactly as a scan registers one. */
function fileHandle(name: string, bytes = 4_096): OfflineFileHandle {
  return {
    kind: "file",
    name,
    getFile: async () => new File([new Uint8Array(bytes)], name),
  };
}

interface OfflineEnv {
  surface: FakeAudioSurface;
  /** Every source the NETWORK resolver was asked for. Must stay empty offline. */
  networkCalls: string[];
  setNetworkUp: (up: boolean) => void;
  dispose: () => void;
}

function resetStore(): void {
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
  resetUnavailableSkipGuardForTests();
}

/**
 * A local track as the folder scan builds it: the id is the folder-relative
 * path (the registry key), and the DISPLAY title comes from the file name, which
 * is why the name carries the title.
 */
function track(id: string, title: string): Track {
  return localTrack({ id, folder: null, name: `${title}.mp3` }) as Track;
}

/**
 * Mounts the real stack over a local fixture, with the network armed.
 *
 * `files` is what the folder scan would have registered: a file listed here is
 * openable, and one omitted from the queue is genuinely gone from the folder.
 */
async function mountOffline(files: string[]): Promise<OfflineEnv> {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  const disposeEngine = usePlayerStore.getState().bindEngine(engine);

  const networkCalls: string[] = [];
  let networkUp = false;
  const resolveAction = vi.fn(async (provider: string, providerTrackId: string) => {
    networkCalls.push(`${provider}:${providerTrackId}`);
    if (!networkUp) {
      // What a server action does with no connectivity: the request itself
      // rejects, so the controller sees a raw transport failure rather than a
      // tidy staged error.
      throw new TypeError("Failed to fetch");
    }
    return { ok: true as const, source: { url: `https://cdn.example/${providerTrackId}.m4a` } };
  });

  const controller = createPlaybackController({
    resolver: createPlaybackResolver([
      createServerSourceResolver(resolveAction),
      createLocalSourceResolver(),
    ]),
    engine,
    reportError: (error) => {
      usePlayerStore.getState().reportPlaybackError(error.kind, error.message);
    },
    onUnavailableTrack: () => {
      usePlayerStore.getState().skipUnavailableTrack();
    },
  });
  setPlaybackController(controller);

  replaceFileRegistry(new Map(files.map((id) => [id, fileHandle(`${id}.mp3`)])));

  return {
    surface,
    networkCalls,
    setNetworkUp: (up: boolean) => {
      networkUp = up;
    },
    dispose: () => {
      controller.shutdown();
      setPlaybackController(null);
      disposeEngine();
      usePlayerStore.getState().bindEngine(null);
    },
  };
}

/** One completion, and the microtask drain the local resolution needs. */
async function advance(surface: FakeAudioSurface): Promise<void> {
  surface.dispatch(EventEnum.ended);
  await flush();
}

const currentTitle = (): string | null => usePlayerStore.getState().currentTrack?.title ?? null;

function upcoming(): string[] {
  const state = usePlayerStore.getState();
  return remainingQueue({
    queue: state.queue,
    playOrder: state.playOrder,
    position: state.position,
    repeat: state.repeat === "all" ? "queue" : state.repeat === "one" ? "track" : "off",
  }).map((entry) => entry.track.title);
}

function setRepeat(mode: "off" | "all" | "one"): void {
  for (let i = 0; i < 3 && usePlayerStore.getState().repeat !== mode; i += 1) {
    usePlayerStore.getState().cycleRepeat();
  }
  expect(usePlayerStore.getState().repeat).toBe(mode);
}

let recordPlayed: ReturnType<typeof vi.fn<(track: Track) => Promise<{ ok: boolean }>>>;

beforeEach(() => {
  installUrlFakes();
  goOffline();
  resetStore();
  recordPlayed = vi.fn().mockResolvedValue({ ok: true });
  setRecordPlayedAction(recordPlayed);
});

afterEach(() => {
  setRecordPlayedAction(null as never);
  resetOfflineSession();
  resetStore();
});

describe("offline / single local track", () => {
  it("loads and plays a local file with no provider request and no connectivity", async () => {
    const env = await mountOffline(["a"]);
    try {
      usePlayerStore.getState().playTrack(track("a", "A"));
      await flush();

      // The bytes reached the element as a local object URL...
      expect(env.surface.src).toMatch(/^blob:/);
      expect(env.surface.playedCalls).toBe(1);
      const state = usePlayerStore.getState();
      expect(state.currentTrack?.title).toBe("A");
      expect(state.isPlaying).toBe(true);
      expect(state.error).toBeNull();
      // ...and the network path, which is registered and reachable, was never
      // taken. One call here would fail this suite rather than degrade it.
      expect(env.networkCalls).toEqual([]);
      expect(window.navigator.onLine).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("records no recently-played write for a local file", async () => {
    // A qualified play fires `recordPlayedAction`, a server action. Offline it
    // is a guaranteed failed request, and the file is not catalog data the
    // server could record anyway.
    const env = await mountOffline(["a"]);
    try {
      usePlayerStore.getState().playTrack(track("a", "A"));
      await flush();
      env.surface.duration = 200;
      env.surface.dispatch(EventEnum.loadedmetadata);
      env.surface.currentTime = 40;
      env.surface.dispatch(EventEnum.timeupdate);
      await flush();

      expect(env.networkCalls).toEqual([]);
      expect(recordPlayed).not.toHaveBeenCalled();
    } finally {
      env.dispose();
    }
  });

  it("mints one object URL per played file and none for the next one", async () => {
    // The next-up prefetch must not speculate for a local file: the browser can
    // read it instantly, so warming it buys nothing and costs an object URL.
    const env = await mountOffline(["a", "b", "c"]);
    try {
      usePlayerStore.getState().playCollection([track("a", "A"), track("b", "B"), track("c", "C")], 0);
      await flush();
      expect(created).toHaveLength(1);
      expect(liveObjectUrlCount()).toBe(1);

      await advance(env.surface);
      expect(currentTitle()).toBe("B");
      await advance(env.surface);
      expect(currentTitle()).toBe("C");
      // Three tracks played, three URLs, none spent on a track not yet heard.
      expect(created).toHaveLength(3);
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});

describe("offline / folder playback", () => {
  it("plays a whole local folder A -> B -> C -> D and then stops", async () => {
    const env = await mountOffline(["a", "b", "c", "d"]);
    try {
      usePlayerStore
        .getState()
        .playCollection([track("a", "A"), track("b", "B"), track("c", "C"), track("d", "D")], 0);
      await flush();
      expect(currentTitle()).toBe("A");

      const played: Array<string | null> = ["A"];
      for (const expected of ["B", "C", "D"]) {
        await advance(env.surface);
        played.push(currentTitle());
        expect(expected).toBe(played[played.length - 1]);
        // Progression is not a paused load: every step really started playing.
        expect(usePlayerStore.getState().isPlaying).toBe(true);
      }
      expect(played).toEqual(["A", "B", "C", "D"]);

      await advance(env.surface);
      const state = usePlayerStore.getState();
      expect(state.isPlaying).toBe(false);
      expect(currentTitle()).toBe("D");
      expect(upcoming()).toEqual([]);
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("walks the queue with Next and Previous offline", async () => {
    const env = await mountOffline(["a", "b", "c"]);
    try {
      usePlayerStore
        .getState()
        .playCollection([track("a", "A"), track("b", "B"), track("c", "C")], 0);
      await flush();

      usePlayerStore.getState().next();
      await flush();
      expect(currentTitle()).toBe("B");
      usePlayerStore.getState().next();
      await flush();
      expect(currentTitle()).toBe("C");

      usePlayerStore.getState().prev();
      await flush();
      expect(currentTitle()).toBe("B");
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});

describe("offline / an unplayable local file", () => {
  it("steps over a file that is gone and skips it exactly once", async () => {
    // "b" is not in the registry: the folder no longer holds it. The existing
    // policy is to step over a track that cannot be played at all, bounded by
    // one pass so an all-dead queue still terminates.
    const env = await mountOffline(["a", "c"]);
    try {
      usePlayerStore
        .getState()
        .playCollection([track("a", "A"), track("b", "B"), track("c", "C")], 0);
      await flush();
      expect(currentTitle()).toBe("A");

      await advance(env.surface);
      await flush();

      // B was skipped, not stalled on, and C is playing.
      expect(currentTitle()).toBe("C");
      expect(usePlayerStore.getState().position).toBe(2);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      expect(upcoming()).toEqual([]);

      // A genuinely missing LOCAL file is not a network problem and must not be
      // reported as one.
      expect(usePlayerStore.getState().error).toBeNull();
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("stops instead of cycling when no file in the queue can be played", async () => {
    const env = await mountOffline([]);
    try {
      usePlayerStore.getState().playCollection([track("a", "A"), track("b", "B")], 0);
      await flush();
      await advance(env.surface);
      await flush();
      await advance(env.surface);
      await flush();

      const state = usePlayerStore.getState();
      expect(state.isPlaying).toBe(false);
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});

describe("offline / loop and shuffle", () => {
  it("wraps the folder under loop queue without touching the network", async () => {
    const env = await mountOffline(["a", "b", "c"]);
    try {
      usePlayerStore
        .getState()
        .playCollection([track("a", "A"), track("b", "B"), track("c", "C")], 0);
      await flush();
      setRepeat("all");

      const played: Array<string | null> = ["A"];
      for (const expected of ["B", "C", "A", "B"]) {
        await advance(env.surface);
        played.push(currentTitle());
        expect(expected).toBe(played[played.length - 1]);
      }
      // The wrap the listener asked for brings the consumed entries back, after
      // the ones still ahead.
      expect(upcoming()).toEqual(["C", "A"]);
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("repeats one local track under loop track without consuming the queue", async () => {
    const env = await mountOffline(["a", "b", "c"]);
    try {
      usePlayerStore
        .getState()
        .playCollection([track("a", "A"), track("b", "B"), track("c", "C")], 0);
      await flush();
      setRepeat("one");

      await advance(env.surface);
      expect(currentTitle()).toBe("A");
      expect(usePlayerStore.getState().position).toBe(0);
      expect(upcoming()).toEqual(["B", "C"]);
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("permutes the folder under shuffle and still plays every file once", async () => {
    const env = await mountOffline(["a", "b", "c", "d"]);
    try {
      usePlayerStore
        .getState()
        .playCollection(
          [track("a", "A"), track("b", "B"), track("c", "C"), track("d", "D")],
          0,
        );
      await flush();
      usePlayerStore.getState().toggleShuffle();
      expect(usePlayerStore.getState().shuffle).toBe(true);

      const visited: Array<string | null> = [currentTitle()];
      for (let i = 0; i < 3; i += 1) {
        await advance(env.surface);
        visited.push(currentTitle());
        expect(usePlayerStore.getState().isPlaying).toBe(true);
      }
      expect(new Set(visited).size).toBe(4);
      expect(upcoming()).toEqual([]);
      await advance(env.surface);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});

describe("offline / session restoration", () => {
  it("resolves a restored local entry from the local files, never the provider", async () => {
    // A local track carries identity only, so the first play must resolve it
    // fresh from the granted folder — which is exactly the moment a network
    // dependency would show up.
    const env = await mountOffline(["a", "b"]);
    try {
      usePlayerStore.getState().restoreQueueSnapshot({
        tracks: [track("a", "A"), track("b", "B")],
        playOrder: [0, 1],
        position: 0,
        shuffle: false,
        repeat: "off",
        mediaPosition: 30,
      });
      await flush();
      expect(currentTitle()).toBe("A");
      expect(usePlayerStore.getState().isPlaying).toBe(false);

      await usePlayerStore.getState().play();
      await flush();

      expect(env.surface.src).toMatch(/^blob:/);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      expect(env.networkCalls).toEqual([]);

      // The saved position is honoured once the local file reports metadata.
      env.surface.duration = 200;
      env.surface.dispatch(EventEnum.loadedmetadata);
      await flush();
      expect(usePlayerStore.getState().currentTime).toBe(30);

      // And the restored queue is fully operable, still offline.
      usePlayerStore.getState().next();
      await flush();
      expect(currentTitle()).toBe("B");
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});

describe("offline / a network failure must not poison local playback", () => {
  it("plays a local file immediately after a provider failure", async () => {
    const env = await mountOffline(["a"]);
    try {
      // Provider track with the network down: resolution fails, as it must.
      usePlayerStore.getState().playTrack({
        id: "aaaaaaaaaaa",
        provider: "youtube",
        providerTrackId: "aaaaaaaaaaa",
        title: "Remote",
        artistId: "UC1",
        artistName: "Artist",
      });
      await flush();
      expect(env.networkCalls.length).toBeGreaterThan(0);
      expect(usePlayerStore.getState().error).not.toBeNull();

      // The local file is unaffected by that failure.
      usePlayerStore.getState().playTrack(track("a", "A"));
      await flush();

      expect(env.surface.src).toMatch(/^blob:/);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      expect(usePlayerStore.getState().error).toBeNull();
      expect(currentTitle()).toBe("A");
    } finally {
      env.dispose();
    }
  });

  it("plays a local file after connectivity drops mid-session", async () => {
    const env = await mountOffline(["a"]);
    try {
      env.setNetworkUp(true);
      usePlayerStore.getState().playTrack({
        id: "bbbbbbbbbbb",
        provider: "youtube",
        providerTrackId: "bbbbbbbbbbb",
        title: "Remote",
        artistId: "UC1",
        artistName: "Artist",
      });
      await flush();
      expect(env.surface.src).toBe("https://cdn.example/bbbbbbbbbbb.m4a");

      // Connectivity is gone now. The local track must not change source type
      // because of it.
      env.setNetworkUp(false);
      usePlayerStore.getState().playTrack(track("a", "A"));
      await flush();

      expect(env.surface.src).toMatch(/^blob:/);
      expect(usePlayerStore.getState().isPlaying).toBe(true);
      expect(currentTitle()).toBe("A");
    } finally {
      env.dispose();
    }
  });

  it("resumes and pauses a loaded local file without re-resolving", async () => {
    const env = await mountOffline(["a"]);
    try {
      usePlayerStore.getState().playTrack(track("a", "A"));
      await flush();
      const minted = created.length;

      usePlayerStore.getState().pause();
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      await usePlayerStore.getState().play();
      await flush();

      expect(usePlayerStore.getState().isPlaying).toBe(true);
      // Resume reuses the URL already on the element: no second object URL, and
      // no network attempt for what is already loaded.
      expect(created).toHaveLength(minted);
      expect(env.networkCalls).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});
