import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  remainingQueue,
  setPlaybackController,
  usePlayerStore,
} from "@/lib/player/store";
import { createQueueManager } from "@/lib/music/queue-manager";
import { PlayerEngine } from "@/lib/player/engine";
import { EventEnum, FakeAudioSurface, makePlayableTrack } from "./fake-audio";
import type { Track } from "@/lib/domain";

/**
 * Cursor-pinned reorder (§34.4).
 *
 * The queue is the full collection plus a play-order cursor (`position` into
 * `playOrder`); `remainingQueue()` derives what is upcoming. A reorder must
 * therefore never move an entry across the cursor: that resurrects a consumed
 * track or strands an upcoming one behind the playhead. Both sides of every
 * adjacent swap must sit on the SAME side of the cursor, and a multi-step
 * manager move touching or crossing the cursor is rejected whole — anything
 * involving the cursor entry itself is a silent no-op, like removing the
 * current track already is.
 *
 * Every test below drives the REAL store (plus the real engine for
 * completions) and asserts state transitions — current identity, cursor,
 * upcoming derivation, next-track result, terminal state — never just an
 * array shape. No fake queue implementation exists here.
 */

function stubController(): void {
  setPlaybackController(null);
}

function mountEngine(): { surface: FakeAudioSurface; dispose: () => void } {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  return { surface, dispose: usePlayerStore.getState().bindEngine(engine) };
}

function manager() {
  return createQueueManager({
    getState: () => usePlayerStore.getState(),
    actions: usePlayerStore.getState(),
  });
}

function tracks(...titles: string[]): Track[] {
  return titles.map(
    (title) =>
      makePlayableTrack(`t-${title}`, { title }) as unknown as Track,
  );
}

function localTracks(...titles: string[]): Track[] {
  return titles.map((title, index) => ({
    id: `local-${index}`,
    provider: "local",
    providerTrackId: `local-${index}`,
    title,
    artistId: "local",
    artistName: "—",
    streamUrl: `blob:local/${index}`,
  }) as unknown as Track);
}

function startAt(surface: FakeAudioSurface, list: Track[], startIndex = 0): void {
  usePlayerStore.getState().replaceQueue(list, { startIndex, autoplay: true });
  surface.dispatch(EventEnum.play);
}

function completeTrack(surface: FakeAudioSurface): void {
  surface.dispatch(EventEnum.ended);
  if (usePlayerStore.getState().isLoading) {
    surface.dispatch(EventEnum.play);
  }
}

const title = () => usePlayerStore.getState().currentTrack?.title ?? null;

function upcoming(): string[] {
  const state = usePlayerStore.getState();
  return remainingQueue({
    queue: state.queue,
    playOrder: state.playOrder,
    position: state.position,
    repeat: state.repeat === "all" ? "queue" : state.repeat === "one" ? "track" : "off",
  }).map((entry) => (entry.track as Track).title);
}

function orderTitles(): string[] {
  const { queue, playOrder } = usePlayerStore.getState();
  return playOrder.map((qi) => queue[qi]?.title ?? "?");
}

function expectPermutation(): void {
  const { queue, playOrder } = usePlayerStore.getState();
  expect([...playOrder].sort((a, b) => a - b)).toEqual(
    queue.map((_, index) => index),
  );
}

function setRepeat(mode: "off" | "all" | "one"): void {
  for (let i = 0; i < 3 && usePlayerStore.getState().repeat !== mode; i += 1) {
    usePlayerStore.getState().cycleRepeat();
  }
  expect(usePlayerStore.getState().repeat).toBe(mode);
}

beforeEach(() => {
  usePlayerStore.setState({ shuffle: false, repeat: "off" });
  usePlayerStore.getState().clearQueue();
});

afterEach(() => {
  usePlayerStore.getState().bindEngine(null);
  setPlaybackController(null);
});

describe("cursor-pinned reorder / upcoming reorder", () => {
  it("A current, D moved before B, plays A -> D -> B -> C with no replay of A", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C", "D"));
      expect(title()).toBe("A");

      manager().move(3, 1);
      expect(title()).toBe("A");
      expect(usePlayerStore.getState().position).toBe(0);
      expect(upcoming()).toEqual(["D", "B", "C"]);
      expectPermutation();

      const played: Array<string | null> = [title()];
      for (let i = 0; i < 3; i += 1) {
        completeTrack(surface);
        played.push(title());
      }
      expect(played).toEqual(["A", "D", "B", "C"]);
      expect(upcoming()).toEqual([]);
      // Terminal: a further completion changes nothing, A never returns.
      completeTrack(surface);
      expect(title()).toBe("C");
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe("cursor-pinned reorder / repeated reorder while advancing", () => {
  it("reorders upcoming twice mid-traversal with no duplicates, no resurrection, no loss", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C", "D", "E"));

      manager().move(4, 2);
      expect(orderTitles()).toEqual(["A", "B", "E", "C", "D"]);
      expect(upcoming()).toEqual(["B", "E", "C", "D"]);

      completeTrack(surface);
      expect(title()).toBe("B");
      manager().move(3, 2);
      expect(orderTitles()).toEqual(["A", "B", "C", "E", "D"]);
      expect(upcoming()).toEqual(["C", "E", "D"]);

      const played: Array<string | null> = ["A", "B"];
      for (let i = 0; i < 3; i += 1) {
        completeTrack(surface);
        played.push(title());
      }
      expect(played).toEqual(["A", "B", "C", "E", "D"]);
      expect(new Set(played).size).toBe(5);
      expect(upcoming()).toEqual([]);
      expectPermutation();
    } finally {
      dispose();
    }
  });
});

describe("cursor-pinned reorder / consumed tracks stay consumed", () => {
  it("rejects moving A after D whole: no partial walk, A never plays again", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C", "D"));
      completeTrack(surface);
      expect(title()).toBe("B");
      expect(upcoming()).toEqual(["C", "D"]);

      const before = [...usePlayerStore.getState().playOrder];
      manager().move(0, 3);
      usePlayerStore.getState().moveQueueItem(0, "down");
      usePlayerStore.getState().moveQueueItem(1, "up");
      expect(usePlayerStore.getState().playOrder).toEqual(before);
      expect(usePlayerStore.getState().position).toBe(1);
      expect(title()).toBe("B");
      expect(upcoming()).toEqual(["C", "D"]);

      const played: Array<string | null> = ["A", "B"];
      completeTrack(surface);
      played.push(title());
      completeTrack(surface);
      played.push(title());
      expect(played).toEqual(["A", "B", "C", "D"]);
    } finally {
      dispose();
    }
  });
});

describe("cursor-pinned reorder / current track is pinned", () => {
  it("moving the current track is a silent no-op: identity, cursor, and next stay correct", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C"));
      completeTrack(surface);
      expect(title()).toBe("B");

      const before = [...usePlayerStore.getState().playOrder];
      const generation = usePlayerStore.getState().userActionGeneration;
      usePlayerStore.getState().moveQueueItem(1, "up");
      usePlayerStore.getState().moveQueueItem(1, "down");
      manager().move(1, 0);
      manager().move(1, 2);
      expect(usePlayerStore.getState().playOrder).toEqual(before);
      expect(usePlayerStore.getState().position).toBe(1);
      expect(title()).toBe("B");
      expect(upcoming()).toEqual(["C"]);
      expect(usePlayerStore.getState().userActionGeneration).toBe(generation);

      // afterEndQueueIndex still resolves past the pinned cursor.
      usePlayerStore.getState().next();
      expect(title()).toBe("C");
      expect(upcoming()).toEqual([]);
    } finally {
      dispose();
    }
  });
});

describe("cursor-pinned reorder / exhaustion", () => {
  it("after A -> B -> C nothing is upcoming and no reorder resurrects a track", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C"));
      completeTrack(surface);
      completeTrack(surface);
      completeTrack(surface);
      expect(title()).toBe("C");
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      expect(upcoming()).toEqual([]);

      manager().move(0, 2);
      usePlayerStore.getState().moveQueueItem(2, "up");
      expect(upcoming()).toEqual([]);
      expect(title()).toBe("C");
      // A further completion still changes nothing.
      completeTrack(surface);
      expect(title()).toBe("C");
    } finally {
      dispose();
    }
  });
});

describe("cursor-pinned reorder / loop and shuffle stay separate", () => {
  it("loop off terminates after C", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C"));
      manager().move(2, 1);
      expect(upcoming()).toEqual(["C", "B"]);
      completeTrack(surface);
      expect(title()).toBe("C");
      completeTrack(surface);
      expect(title()).toBe("B");
      completeTrack(surface);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      expect(upcoming()).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("loop queue wraps intentionally after C, which is replay by request not a reorder bug", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C"));
      setRepeat("all");
      const played: Array<string | null> = [title()];
      for (let i = 0; i < 4; i += 1) {
        completeTrack(surface);
        played.push(title());
      }
      expect(played).toEqual(["A", "B", "C", "A", "B"]);
      // The loop the listener asked for brings consumed entries round behind
      // the cursor — visibly, after the entries still ahead.
      expect(upcoming()).toEqual(["C", "A"]);
    } finally {
      dispose();
    }
  });

  it("loop track repeats without consuming the queue", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C", "D"));
      setRepeat("one");
      completeTrack(surface);
      expect(title()).toBe("A");
      completeTrack(surface);
      expect(title()).toBe("A");
      expect(usePlayerStore.getState().position).toBe(0);
      expect(upcoming()).toEqual(["B", "C", "D"]);
    } finally {
      dispose();
    }
  });

  it("shuffle plus an upcoming reorder visits every track exactly once", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      startAt(surface, tracks("A", "B", "C", "D"));
      usePlayerStore.getState().toggleShuffle();
      expect(usePlayerStore.getState().shuffle).toBe(true);
      const current = title();

      // Positions 1..2 are upcoming under the pinned cursor at 0 regardless
      // of the shuffled permutation, so this swap is always same-side.
      usePlayerStore.getState().moveQueueItem(1, "down");
      expect(title()).toBe(current);
      expect(usePlayerStore.getState().position).toBe(0);
      expectPermutation();

      const visited: Array<string | null> = [title()];
      for (let i = 0; i < 3; i += 1) {
        completeTrack(surface);
        visited.push(title());
      }
      expect(new Set(visited).size).toBe(4);
      expect(upcoming()).toEqual([]);
      // One more completion exhausts the queue instead of wrapping: the title
      // stays put and playback stops.
      completeTrack(surface);
      expect(title()).toBe(visited[visited.length - 1]);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe("cursor-pinned reorder / play folder compatibility", () => {
  const TITLES = ["A", "B", "C", "D", "E"];

  it("folder A-E via playCollection, E before D while at C, plays C -> E -> D with no replay", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      usePlayerStore.getState().playCollection(localTracks(...TITLES));
      surface.dispatch(EventEnum.play);
      expect(title()).toBe("A");
      expect(upcoming()).toEqual(["B", "C", "D", "E"]);

      completeTrack(surface);
      completeTrack(surface);
      expect(title()).toBe("C");
      expect(upcoming()).toEqual(["D", "E"]);

      manager().move(4, 3);
      expect(title()).toBe("C");
      expect(usePlayerStore.getState().position).toBe(2);
      expect(upcoming()).toEqual(["E", "D"]);

      completeTrack(surface);
      expect(title()).toBe("E");
      completeTrack(surface);
      expect(title()).toBe("D");
      completeTrack(surface);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
      expect(upcoming()).toEqual([]);
    } finally {
      dispose();
    }
  });

  it("steps over an unavailable folder track through the existing skip path", () => {
    stubController();
    const { surface, dispose } = mountEngine();
    try {
      usePlayerStore.getState().playCollection(localTracks("A", "B", "C", "D"));
      surface.dispatch(EventEnum.play);
      completeTrack(surface);
      expect(title()).toBe("B");

      usePlayerStore.getState().skipUnavailableTrack();
      surface.dispatch(EventEnum.play);
      expect(title()).toBe("C");
      expect(upcoming()).toEqual(["D"]);

      completeTrack(surface);
      expect(title()).toBe("D");
      completeTrack(surface);
      expect(usePlayerStore.getState().isPlaying).toBe(false);
    } finally {
      dispose();
    }
  });
});
