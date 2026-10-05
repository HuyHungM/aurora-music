import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMusicEngine } from "@/lib/music/music-engine";
import { createQueueManager } from "@/lib/music/queue-manager";
import {
  fakeEnv,
  fakeSignals,
  searchResult,
} from "@/lib/music/__tests__/fake-facade-env";
import { localTrack } from "@/lib/offline/tracks";
import type { TrackIdentity } from "@/lib/domain";

/**
 * Harness-play regression: the store-backed path for a local track.
 *
 * The E2E harness used to bypass the store: it resolved a blob URL itself and
 * called `engine.load()` directly. The element played, but the store's
 * `isPlaying` stayed false — which is exactly the value `MusicReactiveAmbient`
 * branches on, so the loop never started and no graph was ever built. Every
 * browser measurement taken through that path compared silence with silence.
 *
 * The harness now calls `engine.play(track)`, the same entry the Play Folder
 * button uses. This pins the CONTRACT that path must keep from the facade's
 * side:
 *
 *   1. `play()` routes INTO the queue (replace, not a direct engine load).
 *   2. The queue entry keeps the local identity, so the controller's local
 *      resolver (not the server resolver) handles it.
 *   3. The facade's published `currentTrack` names the local source, which is
 *      what the store-derived `__auroraLocalStore` snapshot asserts on.
 *   4. A genuinely unplayable track (no local identity at all) must NOT
 *      pretend to have entered that path — the unplayable guard below proves
 *      assertion 3 is not vacuous: it fails when the track never arrives.
 */
function setup() {
  const env = fakeEnv();
  const getState = () => env.state;
  const manager = createQueueManager({ getState, actions: env.actions });
  const signals = fakeSignals();
  const searchFn = vi.fn(async () => searchResult());
  const storeListeners = new Set<() => void>();
  const engine = createMusicEngine({
    getState,
    actions: env.actions,
    engine: signals,
    search: { search: searchFn },
    lookup: { getTrack: async () => null },
    queue: manager,
    subscribeStore: (listener: () => void) => {
      storeListeners.add(listener);
      return () => {
        storeListeners.delete(listener);
      };
    },
  });
  engine.initialize();
  const notifyStore = () => {
    for (const listener of [...storeListeners]) listener();
  };
  return { env, signals, engine, notifyStore };
}

function localFixtureTrack() {
  return localTrack({ id: "e2e-local-fixture", folder: null, name: "fixture.wav" });
}

describe("harness play path for local tracks", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("routes a local track into the queue instead of loading the engine directly", async () => {
    const { env, engine } = setup();
    await engine.play(localFixtureTrack());
    // The queue holds the track: the harness did not bypass it.
    expect(env.state.queue).toHaveLength(1);
    expect(env.state.queue[0]?.provider).toBe("local");
    expect(env.state.queue[0]?.id).toBe("e2e-local-fixture");
    expect(env.actions.calls.some((call) => call.action === "replaceQueue")).toBe(true);
  });

  it("publishes the local source as the facade's current track", async () => {
    const { engine } = setup();
    await engine.play(localFixtureTrack());
    const state = engine.getState();
    expect(state.currentTrack?.primarySource.source).toBe("local");
    expect(state.currentTrack?.primarySource.id).toBe("e2e-local-fixture");
  });

  it("carries a local identity the PlaybackResolver can pick a local resolver for", async () => {
    // The controller's resolver registry is keyed by `identity.sources`, so a
    // local track MUST canonicalize to an identity whose sources name "local".
    // A track that canonicalizes to a provider identity would flow to the
    // SERVER resolver instead — which is precisely the bypass reintroduced
    // through a different door.
    const { engine } = setup();
    await engine.play(localFixtureTrack());
    const current = engine.getState().currentTrack as TrackIdentity | null;
    expect(current).not.toBeNull();
    expect(
      current?.sources.some((source) => source.source === "local"),
    ).toBe(true);
  });

  it("emits trackStart naming the local track once the engine reports playing", async () => {
    // `onPlaying` needs a current identity: with no queue entry it returns
    // without emitting, so this fails if play() never reached the queue.
    const { env, engine, signals, notifyStore } = setup();
    await engine.play(localFixtureTrack());
    const seen: Array<{ source: string; id: string }> = [];
    engine.on("trackStart", ({ track: started }) => {
      seen.push({
        source: started.primarySource.source,
        id: started.primarySource.id,
      });
    });
    env.state.isPlaying = true;
    notifyStore();
    signals.emitPlaying();
    expect(seen).toEqual([{ source: "local", id: "e2e-local-fixture" }]);
  });

  it("does NOT publish a current track for input that cannot canonicalize", async () => {
    // The control for the three tests above: same facade, same assertions, an
    // input with no stable identity. If these guards passed on an empty store
    // they would be vacuous; this proves they fail when the track never arrives.
    const { engine } = setup();
    await expect(
      engine.play({ provider: "local", providerTrackId: "" }),
    ).rejects.toThrow();
    expect(engine.getState().currentTrack).toBeNull();
  });
});
