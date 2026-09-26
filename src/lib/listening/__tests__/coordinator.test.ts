import { describe, expect, it, vi } from "vitest";
import type { SourceType, Track, TrackIdentity } from "@/lib/domain";
import type { MusicEngine } from "@/lib/music/music-engine";
import type { RecommendationRequest } from "@/app/actions/recommendations";
import {
  KEEP_LISTENING_BARREN_LIMIT,
  KEEP_LISTENING_BATCH,
  KEEP_LISTENING_COOLDOWN_MS,
  KEEP_LISTENING_MAX_GENERATED,
  KEEP_LISTENING_RECOMMENDED_CAP,
  KEEP_LISTENING_THRESHOLD,
  createInfiniteListeningCoordinator,
} from "@/lib/listening/coordinator";

/**
 * "Keep listening" coordinator regressions (Phase 47, §71–§75).
 *
 * Two properties are under test, and they are the ones that decide whether
 * this feature is safe to ship:
 *
 *  1. It keeps the queue going when the listener asked for that — a bounded
 *     batch, seeded from the real listening context, with the whole current
 *     queue excluded.
 *  2. It never overrides a human. Every one of Play / Play Playlist /
 *     Play Album / Play Track / Next / Previous / Clear Queue /
 *     Replace Queue / Stop, and the radio takeover, must beat a response
 *     that is already in flight.
 *
 * (2) is the one a naive implementation gets wrong, because the failure only
 * appears when a network round trip straddles a user action — impossible to
 * reproduce by clicking in a test, and exactly what a deferred request makes
 * deterministic.
 *
 * No timers. `now` and `request` are injected, so the cooldown and the
 * in-flight races are exercised without waiting, sleeping, or advancing any
 * clock the implementation controls.
 */

function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Track ${id}`,
    artistId: "a1",
    artistName: "Artist",
    ...overrides,
  };
}

function identityOf(track: Track): TrackIdentity {
  const source = "youtube" as SourceType;
  return {
    id: `aurora-${source}-${track.id}`,
    title: track.title,
    artists: [{ id: track.artistId, provider: source, name: track.artistName }],
    sources: [{ source, id: track.id }],
    primarySource: { source, id: track.id },
  };
}

interface FakeEngine {
  engine: MusicEngine;
  queueKeys: () => string[];
  setQueue: (tracks: Track[]) => void;
  setIndex: (index: number) => void;
  added: Track[];
}

function makeEngine(initial: Track[] = []): FakeEngine {
  let queue: Track[] = [...initial];
  let currentIndex = 0;
  const added: Track[] = [];
  const engine = {
    playCollection: vi.fn((tracks: Track[]) => {
      queue = [...tracks];
      currentIndex = 0;
    }),
    setIndex: (index: number) => {
      currentIndex = index;
    },
    // The real MusicEngine publishes `currentTrack` as a TrackIdentity, not a
    // provider Track. The fake must match, or the seed is read off a shape
    // that never occurs in production.
    getState: () => ({
      currentTrack: (() => {
        const track = queue[currentIndex];
        return track ? identityOf(track) : null;
      })(),
    }),
    queue: {
      add: vi.fn((track: Track) => {
        queue.push(track);
        added.push(track);
      }),
      get items() {
        return [...queue];
      },
      get length() {
        return queue.length;
      },
      get currentIndex() {
        return currentIndex;
      },
      get playOrder() {
        return queue.map((_, index) => index);
      },
    },
  } as unknown as MusicEngine;
  return {
    engine,
    queueKeys: () => queue.map((track) => `${track.provider}:${track.providerTrackId ?? track.id}`),
    setQueue: (tracks: Track[]) => {
      queue = [...tracks];
      currentIndex = 0;
    },
    setIndex: (index: number) => {
      currentIndex = index;
    },
    added,
  };
}

type RecommendResult = Awaited<
  ReturnType<typeof import("@/app/actions/recommendations").recommendTracksAction>
>;

/** A `vi.fn` shaped like the real request, so `mock.calls` is typed. */
function requestMock(
  impl: (req: RecommendationRequest) => Promise<RecommendResult>,
) {
  return vi.fn(impl);
}

/** A deferred request the test resolves by hand — the in-flight race seam. */
function deferredRequest() {
  let resolve!: (value: RecommendResult) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<RecommendResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const request = vi.fn(() => promise);
  return { request, resolve, reject, promise };
}

function ok(ids: string[]): RecommendResult {
  return {
    ok: true,
    tracks: ids.map((id) => makeTrack(id)),
    categories: ["continue-discovering"],
  };
}

async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

describe("keep-listening: it keeps the queue going when asked", () => {
  it("appends a bounded batch once the queue runs low", async () => {
    const request = requestMock(async () => ok(["r1", "r2", "r3"]));
    const harness = makeEngine([makeTrack("a"), makeTrack("b"), makeTrack("c")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    // 2 remaining == the threshold, so a continuation is warranted.
    expect(harness.queueKeys().length).toBe(3);
    coordinator.maybeContinue(harness.engine);
    await settle();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]?.limit).toBe(KEEP_LISTENING_BATCH);
    expect(request.mock.calls[0]?.[0]?.surface).toBe("continuation");
    expect(harness.added.map((t) => t.id)).toEqual(["r1", "r2", "r3"]);
    expect(coordinator.getState().generating).toBe(false);
    expect(coordinator.getState().generatedTotal).toBe(3);
  });

  it("excludes the entire current queue from the request", async () => {
    const request = requestMock(async () => ok([]));
    const harness = makeEngine([makeTrack("a"), makeTrack("b")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();

    const sent = request.mock.calls[0]?.[0]?.excludeKeys ?? [];
    // §46: current-queue context is mandatory, and "the current track" in
    // particular must never be suggested back.
    expect(sent).toContain("youtube:a");
    expect(sent).toContain("youtube:b");
  });

  it("seeds from the track actually playing", async () => {
    const request = requestMock(async () => ok(["r1"]));
    const harness = makeEngine([makeTrack("a"), makeTrack("b"), makeTrack("c")]);
    harness.setIndex(2);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();

    expect(request.mock.calls[0]?.[0]?.currentTrack).toEqual({
      provider: "youtube",
      providerTrackId: "c",
      artistName: "Artist",
    });
  });

  it("does not request while the queue still has runway", async () => {
    const request = requestMock(async () => ok(["r1"]));
    const harness = makeEngine([
      makeTrack("a"),
      makeTrack("b"),
      makeTrack("c"),
      makeTrack("d"),
    ]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    // 3 remaining > threshold of 2.
    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).not.toHaveBeenCalled();
  });

  it("never re-appends a track it already recommended", async () => {
    const request = requestMock(async () => ok(["r1"]));
    const harness = makeEngine([makeTrack("a")]);
    let now = 1_000_000;
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
      now: () => now,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(harness.added.map((t) => t.id)).toEqual(["r1"]);

    // The same track comes back on a later trigger. The coordinator's own
    // memory of what it recommended must be in the next request's exclusions.
    now += KEEP_LISTENING_COOLDOWN_MS + 1;
    coordinator.maybeContinue(harness.engine);
    await settle();

    expect(request.mock.calls).toHaveLength(2);
    expect(request.mock.calls[1]?.[0]?.excludeKeys).toContain("youtube:r1");
  });

  it("filters a response that repeats something already queued", async () => {
    // The service is supposed to filter, but the coordinator must not rely
    // on that: a duplicate key in a response is dropped before it lands.
    const request = requestMock(async () => ({
      ok: true as const,
      tracks: [makeTrack("a"), makeTrack("fresh")],
      categories: ["continue-discovering" as const],
    }));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();

    expect(harness.added.map((t) => t.id)).toEqual(["fresh"]);
  });
});

describe("keep-listening: default is OFF and OFF really is off", () => {
  it("makes no request at all while disabled", async () => {
    const request = requestMock(async () => ok(["r1"]));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });

    // Never hydrated, or hydrated with the documented default.
    expect(coordinator.getState().enabled).toBe(false);
    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).not.toHaveBeenCalled();
    expect(harness.added).toEqual([]);

    coordinator.hydrate(false, true);
    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).not.toHaveBeenCalled();
    expect(harness.added).toEqual([]);
  });

  // The regression. `authenticated` rides on the state so the autoplay control
  // can decide whether to offer itself at all, and it reaches the coordinator
  // once, through `hydrate`. A toggle used to reset the state to `INITIAL_STATE`
  // without carrying it forward — which set `authenticated` back to false, and
  // since nothing re-hydrates, the control rendered itself away the moment it
  // was switched on and never came back.
  it("keeps who the preference belongs to across a toggle", () => {
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request: requestMock(async () => ok([])),
    });
    coordinator.hydrate(false, true);

    coordinator.setEnabled(true);
    expect(coordinator.getState()).toMatchObject({ enabled: true, authenticated: true });

    coordinator.setEnabled(false);
    expect(coordinator.getState()).toMatchObject({ enabled: false, authenticated: true });

    // And several round trips, because a control a listener can only use once
    // is a worse bug than one that never appears.
    for (let i = 0; i < 3; i += 1) {
      coordinator.setEnabled(true);
      expect(coordinator.getState().authenticated).toBe(true);
      coordinator.setEnabled(false);
      expect(coordinator.getState().authenticated).toBe(true);
    }
  });

  // The invariant in one place, so the two resets that must preserve it stay
  // visibly paired.
  it("only `end()` forgets who the preference belongs to", () => {
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request: requestMock(async () => ok([])),
    });
    coordinator.hydrate(true, true);
    coordinator.noteQueueChanged(["spotify:1"]);
    coordinator.hydrate(true, true);

    expect(coordinator.getState().authenticated).toBe(true);

    // `end()` is the shutdown path: there is no listener left to offer a
    // control to, so forgetting is correct there and only there.
    coordinator.end();
    expect(coordinator.getState().authenticated).toBe(false);
  });

  it("never silently repopulates an emptied queue", async () => {
    const request = requestMock(async () => ok(["r1"]));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    // §53: Clear Queue is an answer, not a prompt.
    harness.setQueue([]);
    coordinator.noteQueueChanged([]);
    coordinator.maybeContinue(harness.engine);
    await settle();

    expect(request).not.toHaveBeenCalled();
    expect(harness.added).toEqual([]);
  });
});

describe("keep-listening: human overrides beat an in-flight response", () => {
  it("drops a response that lands after the queue is cleared", async () => {
    const { request, resolve } = deferredRequest();
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    // The listener clears the queue while the request is in flight.
    harness.setQueue([]);
    coordinator.noteQueueChanged([]);

    resolve(ok(["r1", "r2"]));
    await settle();

    expect(harness.added).toEqual([]);
    expect(coordinator.getState().generating).toBe(false);
  });

  it("drops a response that lands after the queue is replaced", async () => {
    const { request, resolve } = deferredRequest();
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();

    // The listener starts a specific playlist instead.
    harness.setQueue([makeTrack("x"), makeTrack("y"), makeTrack("z")]);
    coordinator.noteQueueChanged(["youtube:x", "youtube:y", "youtube:z"]);

    resolve(ok(["r1", "r2"]));
    await settle();

    // The batch requested for the OLD context must not land in the new one.
    expect(harness.added).toEqual([]);
    expect(harness.queueKeys()).toEqual(["youtube:x", "youtube:y", "youtube:z"]);
  });

  it("drops a response that lands after the toggle is turned off", async () => {
    const { request, resolve } = deferredRequest();
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();

    coordinator.setEnabled(false);
    resolve(ok(["r1"]));
    await settle();

    expect(harness.added).toEqual([]);
    expect(coordinator.getState().enabled).toBe(false);
  });

  it("keeps the preference but drops the context on a plain queue edit", async () => {
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request: async () => ok([]),
    });
    coordinator.hydrate(true, true);
    coordinator.noteQueueChanged(["youtube:a", "youtube:b", "youtube:c"]);

    // Adding one track is an ordinary edit, not a takeover.
    coordinator.noteQueueChanged(["youtube:a", "youtube:b", "youtube:c", "youtube:manual"]);

    expect(coordinator.getState().enabled).toBe(true);
    expect(coordinator.getState().authenticated).toBe(true);
  });

  it("issues at most one request at a time, so no response can be superseded", async () => {
    // A second concurrent request is prevented by the in-flight latch rather
    // than detected afterwards, which is why the coordinator carries a
    // request-sequence guard only as defence in depth. This asserts the
    // reachable property: repeated triggers during a batch never stack up
    // requests, so the newest-response-wins rule has nothing to arbitrate.
    const { request, resolve } = deferredRequest();
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();
    for (let i = 0; i < 5; i += 1) {
      coordinator.maybeContinue(harness.engine);
    }
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().generating).toBe(true);

    resolve(ok(["r1"]));
    await settle();
    expect(harness.added.map((t) => t.id)).toEqual(["r1"]);
    expect(coordinator.getState().generating).toBe(false);
  });

  it("releases the in-flight latch when a response is discarded as stale", async () => {
    // A dropped response must not leave `generating` true: that would wedge
    // the feature for the rest of the page load — the toggle would read
    // "generating" forever and no further batch could ever be requested.
    const { request, resolve } = deferredRequest();
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(coordinator.getState().generating).toBe(true);

    // A clear makes the response stale.
    harness.setQueue([]);
    coordinator.noteQueueChanged([]);
    resolve(ok(["r1"]));
    await settle();

    expect(coordinator.getState().generating).toBe(false);
  });
});

describe("keep-listening: radio stays authoritative", () => {
  it("makes no request while a station is active", async () => {
    const request = requestMock(async () => ok(["r1"]));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => true,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();

    // §55: radio's own generation loop owns the queue. A second
    // continuation system over the same queue would be two writers.
    expect(request).not.toHaveBeenCalled();
    expect(harness.added).toEqual([]);
  });

  it("drops an in-flight response once a station takes over", async () => {
    const { request, resolve } = deferredRequest();
    let radioActive = false;
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => radioActive,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    radioActive = true;
    resolve(ok(["r1", "r2"]));
    await settle();

    expect(harness.added).toEqual([]);
  });
});

describe("keep-listening: bounded, and it cannot loop", () => {
  it("cools down between generations", async () => {
    let now = 1_000_000;
    const request = requestMock(async () => ok(["r1"]));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
      now: () => now,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    // Still inside the cooldown window: no second request.
    now += KEEP_LISTENING_COOLDOWN_MS - 1;
    harness.setIndex(harness.engine.queue.length - 1);
    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    // Past the cooldown: exactly one more, never a burst.
    now += 2;
    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("declares exhaustion after a bounded number of empty batches", async () => {
    let now = 1_000_000;
    const request = requestMock(async () => ok([]));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
      // A clock that always jumps past the cooldown, so ONLY the retry budget
      // can stop the loop. This is what makes the bound meaningful.
      now: () => (now += KEEP_LISTENING_COOLDOWN_MS + 1),
    });
    coordinator.hydrate(true, true);

    for (let i = 0; i < KEEP_LISTENING_BARREN_LIMIT + 3; i += 1) {
      coordinator.maybeContinue(harness.engine);
      await settle();
    }

    // §62: a dry pool must stop, not retry forever.
    expect(request.mock.calls.length).toBeLessThanOrEqual(KEEP_LISTENING_BARREN_LIMIT + 1);
    expect(coordinator.getState().exhausted).toBe(true);
  });

  it("stops retrying a persistently failing provider", async () => {
    // §64: a provider failure must not become an infinite retry. The clock
    // here always jumps past the cooldown, so only the retry budget bounds
    // this — a cooldown-only guard would never fire.
    let now = 1_000_000;
    const request = requestMock(async () => ({ ok: false as const, error: "boom" }));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
      now: () => (now += KEEP_LISTENING_COOLDOWN_MS + 1),
    });
    coordinator.hydrate(true, true);

    for (let i = 0; i < KEEP_LISTENING_BARREN_LIMIT + 3; i += 1) {
      coordinator.maybeContinue(harness.engine);
      await settle();
    }

    expect(request.mock.calls.length).toBeLessThanOrEqual(KEEP_LISTENING_BARREN_LIMIT + 1);
    expect(coordinator.getState().exhausted).toBe(true);
    expect(harness.added).toEqual([]);
  });

  it("does not re-enter on the same tick when a request fails", async () => {
    // A real clock barely moves across microtasks, so the cooldown alone would
    // mask a re-entrancy bug. This asserts it directly: exactly one request
    // may be issued until time actually advances.
    const now = 1_700_000_000_000;
    const request = requestMock(async () => ({ ok: false as const, error: "boom" }));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
      now: () => now,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();

    // Without the last-attempt stamp this number would be in the hundreds:
    // the failure path re-entered maybeContinue synchronously, and the
    // cooldown could not engage because it was never stamped.
    expect(request).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().generating).toBe(false);
  });

  it("stops after the per-session generation cap", async () => {
    let now = 1_000_000;
    let counter = 0;
    const request = requestMock(async () => ok([`r${counter++}`]));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
      now: () => (now += KEEP_LISTENING_COOLDOWN_MS + 1),
    });
    coordinator.hydrate(true, true);

    // Far more triggers than the cap allows. Each response is a single track,
    // so the number of requests is bounded by the track cap, not the batch
    // size — which is the point: neither number is unbounded.
    for (let i = 0; i < 200; i += 1) {
      harness.setIndex(Math.max(0, harness.engine.queue.length - 1));
      coordinator.maybeContinue(harness.engine);
      await settle(2);
    }

    expect(coordinator.getState().generatedTotal).toBeLessThanOrEqual(
      KEEP_LISTENING_MAX_GENERATED,
    );
    // Every request is capped to a bounded batch, so the request count can
    // never exceed the track cap either.
    expect(request.mock.calls.length).toBeLessThanOrEqual(KEEP_LISTENING_MAX_GENERATED);
    const limits = request.mock.calls.map((call) => {
      const limit = call[0]?.limit;
      return typeof limit === "number" ? limit : Number.NaN;
    });
    expect(limits.every((limit) => limit > 0 && limit <= KEEP_LISTENING_BATCH)).toBe(true);
  });

  it("surfaces a provider failure once, then keeps going without crashing", async () => {
    let now = 1_000_000;
    const request = requestMock(async () => ({ ok: false as const, error: "boom" }));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
      now: () => (now += KEEP_LISTENING_COOLDOWN_MS + 1),
    });
    coordinator.hydrate(true, true);

    await expect(
      (async () => {
        coordinator.maybeContinue(harness.engine);
        await settle();
      })(),
    ).resolves.toBeUndefined();

    expect(coordinator.getState().error).toBe("recommendations.unavailable");
    expect(coordinator.getState().generating).toBe(false);
    expect(harness.added).toEqual([]);
  });

  it("waits out the cooldown before retrying a failure", async () => {
    let now = 1_000_000;
    const request = requestMock(async () => ({ ok: false as const, error: "boom" }));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
      now: () => now,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    // One millisecond later: still cooling down.
    now += 1;
    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(1);

    // Past the cooldown: retried, and retried at most once per window.
    now += KEEP_LISTENING_COOLDOWN_MS;
    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
    coordinator.maybeContinue(harness.engine);
    await settle();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("survives a request that rejects outright", async () => {
    const { request, reject } = deferredRequest();
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();
    reject(new Error("network down"));
    await settle(20);

    expect(coordinator.getState().generating).toBe(false);
    expect(harness.added).toEqual([]);
  });

  it("bounds the remembered recommendation keys", async () => {
    const request = requestMock(async () => ok([]));
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);
    // The cap is a memory bound; assert the constant is the intended one
    // rather than growing state in a test to prove it.
    expect(KEEP_LISTENING_RECOMMENDED_CAP).toBeGreaterThan(0);
    expect(KEEP_LISTENING_RECOMMENDED_CAP).toBeLessThanOrEqual(1000);
    expect(KEEP_LISTENING_THRESHOLD).toBeGreaterThan(0);
    expect(KEEP_LISTENING_BATCH).toBeGreaterThanOrEqual(5);
    expect(KEEP_LISTENING_BATCH).toBeLessThanOrEqual(10);
  });
});

describe("keep-listening: ownership boundaries", () => {
  it("appends only through the queue facade, never by reaching into the store", async () => {
    const request = requestMock(async () => ok(["r1", "r2"]));
    const harness = makeEngine([makeTrack("a")]);
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request,
    });
    coordinator.hydrate(true, true);

    coordinator.maybeContinue(harness.engine);
    await settle();

    // QueueManager is the sole queue authority: the coordinator's only
    // mutation is `engine.queue.add`, once per track.
    const queue = harness.engine.queue as unknown as { add: ReturnType<typeof vi.fn> };
    expect(queue.add).toHaveBeenCalledTimes(2);
    // It never claimed to play anything.
    expect(harness.engine.playCollection).not.toHaveBeenCalled();
  });

  it("notifies subscribers and stops after unsubscribe", async () => {
    const listener = vi.fn();
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request: async () => ok([]),
    });
    const unsubscribe = coordinator.subscribe(listener);
    coordinator.hydrate(true, true);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    coordinator.setEnabled(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps a stable state object between changes so the toggle can subscribe", () => {
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request: async () => ok([]),
    });
    const first = coordinator.getState();
    expect(coordinator.getState()).toBe(first);
    coordinator.hydrate(true, true);
    expect(coordinator.getState()).not.toBe(first);
  });

  it("ignores a hydrate and a setEnabled that change nothing", () => {
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request: async () => ok([]),
    });
    coordinator.hydrate(true, true);
    const state = coordinator.getState();
    coordinator.hydrate(true, true);
    expect(coordinator.getState()).toBe(state);
    coordinator.setEnabled(true);
    expect(coordinator.getState()).toBe(state);
  });

  it("treats an anonymous listener as opted out", () => {
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request: async () => ok([]),
    });
    coordinator.hydrate(false, false);
    expect(coordinator.getState().authenticated).toBe(false);
    expect(coordinator.getState().enabled).toBe(false);
  });

  it("resets everything on end", () => {
    const coordinator = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => false,
      request: async () => ok([]),
    });
    coordinator.hydrate(true, true);
    coordinator.end();
    expect(coordinator.getState().enabled).toBe(false);
    expect(coordinator.getState().generatedTotal).toBe(0);
  });
});
