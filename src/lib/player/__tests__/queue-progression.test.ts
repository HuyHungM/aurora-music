import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  remainingQueue,
  setPlaybackController,
  usePlayerStore,
} from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { EventEnum, FakeAudioSurface, makePlayableTrack } from "./fake-audio";
import type { Track } from "@/lib/domain";

/**
 * Queue progression correctness.
 *
 * The invariant under test: **the queue is what REMAINS, not playback history**,
 * and one completion of one track consumes exactly one track.
 *
 * Every test here is written so that restoring the old behaviour makes it fail,
 * and the two headline regressions state the measured failure they prevent.
 */

/**
 * NO controller stub: these tests drive the real engine.
 *
 * The engine is what attributes a completion to a track, so a stubbed
 * controller — which replaces the load path and leaves the element holding
 * nothing — would test a store that can never legitimately advance. Binding the
 * engine alone is a supported configuration and it is the one where the
 * attribution is actually exercised.
 */
function stubController(): void {
  setPlaybackController(null);
}

function mountEngine(): { surface: FakeAudioSurface; dispose: () => void } {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  const dispose = usePlayerStore.getState().bindEngine(engine);
  return { surface, dispose };
}

/** A, B, C, D — distinct titles so an assertion can name the track. */
function fourTracks(): Track[] {
  return (["A", "B", "C", "D"] as const).map((title) =>
    makePlayableTrack(`t-${title}`, { title }),
  ) as Track[];
}

/**
 * Plays the current track to completion: report `ended`, and let the element
 * start the replacement when one was selected — which is what a real element
 * does, and what gives the next completion an identity to carry.
 */
function completeTrack(surface: FakeAudioSurface): void {
  surface.dispatch(EventEnum.ended);
  if (usePlayerStore.getState().isLoading) {
    surface.dispatch(EventEnum.play);
  }
}

const title = () => usePlayerStore.getState().currentTrack?.title ?? null;

/**
 * The store's remaining queue, in the PRODUCT loop vocabulary.
 *
 * The store keeps `RepeatMode` (`one` / `all`) because that is what its
 * transition reads; a surface knows its controls as `track` / `queue`. The
 * mapping is the inverse of `repeatModeOf` in `queue-manager.ts` and is spelled
 * out here rather than imported so this suite keeps testing the store's own
 * state without a second public helper that exists only for tests.
 */
function storeRemaining() {
  const state = usePlayerStore.getState();
  return remainingQueue({
    queue: state.queue,
    playOrder: state.playOrder,
    position: state.position,
    repeat: state.repeat === "all" ? "queue" : state.repeat === "one" ? "track" : "off",
  });
}

/** Cycles the repeat mode round to `target`. `clearQueue` does not reset it. */
function setRepeat(mode: "off" | "all" | "one"): void {
  for (let i = 0; i < 3 && usePlayerStore.getState().repeat !== mode; i += 1) {
    usePlayerStore.getState().cycleRepeat();
  }
  expect(usePlayerStore.getState().repeat).toBe(mode);
}

/**
 * Replaces the queue and lets the element start producing the first track.
 *
 * The `play` dispatch is not optional: it is the moment the engine captures
 * which track the element is playing, and a completion with no attribution is
 * correctly refused. Omitting it would make every progression test assert
 * nothing.
 */
function startAt(surface: FakeAudioSurface, tracks: Track[], startIndex = 0): void {
  usePlayerStore.getState().replaceQueue(tracks, { startIndex, autoplay: true });
  surface.dispatch(EventEnum.play);
}

beforeEach(() => {
  usePlayerStore.getState().clearQueue();
  setRepeat("off");
});

afterEach(() => {
  usePlayerStore.getState().bindEngine(null);
  setPlaybackController(null);
  vi.unstubAllGlobals();
});

describe("queue progression / order", () => {
  it("plays A -> B -> C -> D and then stops, with loop off", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      expect(title()).toBe("A");

      completeTrack(surface);
      expect(title()).toBe("B");
      completeTrack(surface);
      expect(title()).toBe("C");
      completeTrack(surface);
      expect(title()).toBe("D");

      completeTrack(surface);
      // Terminal state: stopped, nothing playing. The store's terminal state is
      // "cursor past the end", which is what `isPlaying: false` reads from.
      const state = usePlayerStore.getState();
      expect(state.isPlaying).toBe(false);
      expect(state.position).toBeGreaterThanOrEqual(state.playOrder.length - 1);
      // And it stays stopped: a further completion changes nothing.
      completeTrack(surface);
      expect(title()).toBe("D");
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      dispose();
    }
  });

  it("never returns to A with loop off", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      const played: Array<string | null> = [];
      startAt(surface, fourTracks());
      played.push(title());
      for (let i = 0; i < 6; i += 1) {
        completeTrack(surface);
        played.push(title());
      }
      expect(played).toEqual(["A", "B", "C", "D", "D", "D", "D"]);
    } finally {
      dispose();
    }
  });

  it("manual Next has the same queue semantics as a natural end", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      usePlayerStore.getState().next();
      expect(title()).toBe("B");
      usePlayerStore.getState().next();
      expect(title()).toBe("C");
      usePlayerStore.getState().next();
      expect(title()).toBe("D");
      usePlayerStore.getState().next();
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      // And the element agrees with the model, so the next `ended` advances
      // nothing.
      completeTrack(surface);
      expect(title()).toBe("D");
    } finally {
      dispose();
    }
  });
});

describe("queue progression / loop modes", () => {
  it("repeat-one replays the same track without consuming the queue", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      setRepeat("one");

      completeTrack(surface);
      expect(title()).toBe("A");
      completeTrack(surface);
      expect(title()).toBe("A");
      // Nothing was consumed: the remaining queue is untouched.
      expect(storeRemaining()).toHaveLength(3);
    } finally {
      dispose();
    }
  });

  it("repeat-one does not trap the listener at the end of the queue", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks(), 3);
      setRepeat("one");
      completeTrack(surface);
      expect(title()).toBe("D");
      // Next is a user action and leaves repeat-one, exactly as the store's own
      // contract documents.
      usePlayerStore.getState().next();
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      dispose();
    }
  });

  it("repeat-all wraps back to A after D", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      setRepeat("all");

      for (const expected of ["B", "C", "D", "A", "B"]) {
        completeTrack(surface);
        expect(title()).toBe(expected);
      }
    } finally {
      dispose();
    }
  });

  it("repeat-all makes the consumed entries visible again, after the cursor", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      setRepeat("all");
      completeTrack(surface);
      completeTrack(surface);
      expect(title()).toBe("C");
      // The loop the listener asked for means A and B come round again — so they
      // are in the remaining queue, but never BEFORE the entries still ahead.
      const titles = remainingQueue({
        ...usePlayerStore.getState(),
        repeat: "queue",
      }).map((entry) => entry.track.title);
      expect(titles).toEqual(["D", "A", "B"]);
    } finally {
      dispose();
    }
  });
});

describe("queue progression / one completion consumes one track", () => {
  it("does not consume a second track when `ended` is reported twice", () => {
    // THE REGRESSION. Measured on this harness before the fix: one playback of
    // A followed by two `ended` reports advanced the cursor TWICE, so the queue
    // went A -> B -> D and the listener never heard C. A media element can
    // report the end of one playback more than once; every extra report must be
    // ignored.
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());

      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("B");

      // A duplicate report for the SAME playback, with nothing started since.
      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("B");

      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("B");

      // Once the new track starts, a genuine completion is honoured again.
      surface.dispatch(EventEnum.play);
      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("C");
    } finally {
      dispose();
    }
  });

  it("does not skip a track when `ended` arrives after a manual Next", () => {
    // The race the brief names: Next mutates the cursor and starts a load, and
    // the track being replaced reports its own completion afterwards. The user
    // action establishes new intent, so the stale report must not consume it.
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());

      usePlayerStore.getState().next();
      expect(title()).toBe("B");

      // The track `Next` replaced has not started playing, so its completion
      // carries no attribution and must not consume the track Next selected.
      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("B");

      surface.dispatch(EventEnum.play);
      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("C");
    } finally {
      dispose();
    }
  });

  it("rapid Next presses consume one track each, in order", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      usePlayerStore.getState().next();
      usePlayerStore.getState().next();
      usePlayerStore.getState().next();
      expect(title()).toBe("D");
      // Four tracks, three advances: exactly one left, no skip, no repeat.
      expect(storeRemaining()).toHaveLength(0);
      usePlayerStore.getState().next();
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      expect(title()).toBe("D");
    } finally {
      dispose();
    }
  });

  it("a completion at the end of the queue does not restart it", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks(), 3);
      surface.dispatch(EventEnum.ended);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      surface.dispatch(EventEnum.ended);
      expect(title()).toBe("D");
    } finally {
      dispose();
    }
  });
});

describe("remainingQueue / the queue is what remains", () => {
  const queue = fourTracks();
  const order = { queue, playOrder: [0, 1, 2, 3], position: 0, repeat: "off" as const };

  it("holds the whole queue when nothing is loaded", () => {
    const entries = remainingQueue({ queue, playOrder: [0, 1, 2, 3], position: -1, repeat: "off" });
    expect(entries.map((entry) => entry.track.title)).toEqual(["A", "B", "C", "D"]);
  });

  it("excludes the current track and everything already played", () => {
    // THE REGRESSION, at the derivation the panel reads. Before the fix the
    // panel filtered out only the CURRENT track, so after A -> B -> C it
    // rendered the queue as [A, B, D]: two songs the listener had already
    // finished, still looking upcoming.
    const entries = remainingQueue({ ...order, position: 2 });
    expect(entries.map((entry) => entry.track.title)).toEqual(["D"]);
  });

  it("shrinks as the queue is consumed", () => {
    const sizes = [0, 1, 2, 3].map(
      (position) => remainingQueue({ ...order, position }).length,
    );
    expect(sizes).toEqual([3, 2, 1, 0]);
  });

  it("does not drop the final track before it has played", () => {
    expect(remainingQueue({ ...order, position: 2 })).toHaveLength(1);
    expect(remainingQueue({ ...order, position: 3 })).toHaveLength(0);
  });

  it("follows the play order, not the queue array", () => {
    // Shuffle permutes `playOrder` only. Reading `queue` directly — or treating
    // a position as a queue index — is exactly how a skipped track appears.
    const entries = remainingQueue({
      queue,
      playOrder: [2, 0, 3, 1],
      position: 0,
      repeat: "off",
    });
    expect(entries.map((entry) => entry.track.title)).toEqual(["A", "D", "B"]);
  });

  it("carries the position and queue index every mutation needs", () => {
    const entries = remainingQueue({ ...order, position: 0 });
    expect(entries[0]).toMatchObject({ position: 1, queueIndex: 1 });
  });

  it("is empty for an empty queue", () => {
    expect(remainingQueue({ queue: [], playOrder: [], position: -1, repeat: "off" })).toEqual([]);
  });

  it("survives a play order that points past the queue", () => {
    // A stale or hand-edited snapshot must not produce `undefined` rows.
    const entries = remainingQueue({
      queue,
      playOrder: [0, 9, 2],
      position: 0,
      repeat: "off",
    });
    expect(entries.map((entry) => entry.track.title)).toEqual(["C"]);
  });
});

describe("previous / history", () => {
  it("goes back without duplicating queue entries", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      completeTrack(surface);
      completeTrack(surface);
      expect(title()).toBe("C");

      usePlayerStore.getState().prev();
      expect(title()).toBe("B");
      // B is still queued exactly once, and it is still ahead of nothing.
      const state = usePlayerStore.getState();
      expect(state.queue.filter((track) => track.title === "B")).toHaveLength(1);
      expect(storeRemaining().map((entry) => entry.track.title)).toEqual(["C", "D"]);

      usePlayerStore.getState().prev();
      expect(title()).toBe("A");
      expect(storeRemaining().map((e) => e.track.title)).toEqual([
        "B",
        "C",
        "D",
      ]);
    } finally {
      dispose();
    }
  });

  it("restarts the current track instead of going back past the start", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      usePlayerStore.getState().prev();
      expect(title()).toBe("A");
      expect(usePlayerStore.getState().position).toBe(0);
    } finally {
      dispose();
    }
  });
});

describe("queue initialization", () => {
  it("starting A in [A, B, C, D] does not replay A", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      expect(title()).toBe("A");
      completeTrack(surface);
      // The regression shape: A -> A -> B, which is what a queue that still
      // contains the current track at the cursor produces.
      expect(title()).toBe("B");
    } finally {
      dispose();
    }
  });

  it("the remaining queue after initialization excludes the start track", () => {
    const state = usePlayerStore.getState();
    state.replaceQueue(fourTracks(), { startIndex: 1 });
    expect(storeRemaining().map((e) => e.track.title)).toEqual([
      "C",
      "D",
    ]);
  });
});

describe("shuffle", () => {
  it("does not reintroduce a consumed track while shuffle is on", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      const tracks = fourTracks();
      startAt(surface, tracks);
      usePlayerStore.getState().toggleShuffle();
      expect(usePlayerStore.getState().shuffle).toBe(true);

      const order = usePlayerStore.getState().playOrder;
      // Every entry appears exactly once, so a shuffled run cannot repeat one
      // until the order itself wraps — and `repeat` is `off`, so it does not.
      expect([...order].sort()).toEqual([0, 1, 2, 3]);

      const visited: number[] = [usePlayerStore.getState().position];
      // Four completions for four tracks: the fourth exhausts the queue.
      for (let i = 0; i < 4; i += 1) {
        completeTrack(surface);
        visited.push(usePlayerStore.getState().position);
      }
      expect(new Set(visited).size, `positions visited: ${visited.join(",")}`).toBe(4);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      dispose();
    }
  });

  it("turning shuffle off keeps the current track current", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, fourTracks());
      completeTrack(surface);
      completeTrack(surface);
      const before = title();
      usePlayerStore.getState().toggleShuffle();
      expect(usePlayerStore.getState().shuffle).toBe(false);
      // Toggling order must not change WHAT is playing, only what comes next.
      expect(title()).toBe(before);
    } finally {
      dispose();
    }
  });
});
