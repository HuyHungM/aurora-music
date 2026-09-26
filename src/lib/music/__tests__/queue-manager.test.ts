import { beforeEach, describe, expect, it } from "vitest";
import type { Track } from "@/lib/domain";
import {
  NormalizationError,
  mergeSourceReference,
  toTrackIdentity,
} from "@/lib/domain";
import { identityToTrack } from "@/lib/music/identity-track";
import { usePlayerStore } from "@/lib/player/store";
import { createQueueManager } from "@/lib/music/queue-manager";
import type { QueueManager } from "@/lib/music/queue-manager";

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Song ${id}`,
    artistId: "youtube-a1",
    artistName: "Artist",
    ...overrides,
  };
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
    persistenceInitState: "idle",
    userActionGeneration: 0,
    pendingRestorePosition: null,
    qualifiedTrackKey: null,
  });
}

function manager(): QueueManager {
  return createQueueManager({
    getState: () => usePlayerStore.getState(),
    actions: usePlayerStore.getState(),
  });
}

function raw() {
  return usePlayerStore.getState();
}

/** playOrder must always permute 0..n-1 with no gaps or duplicates. */
function expectPermutation(n: number) {
  const { queue, playOrder } = raw();
  expect(queue).toHaveLength(n);
  expect(playOrder).toHaveLength(n);
  expect([...playOrder].sort((a, b) => a - b)).toEqual(
    Array.from({ length: n }, (_, index) => index),
  );
}

beforeEach(() => {
  resetStore();
});

describe("add", () => {
  it("appends to empty and non-empty queues without autoplay", () => {
    const queue = manager();
    queue.add(track("a"));
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a"]);
    expect(raw().isPlaying).toBe(false);
    queue.add(track("b"));
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a", "b"]);
    expectPermutation(2);
  });

  it("rejects a duplicate add and still appends correctly under shuffle", () => {
    const queue = manager();
    queue.add(track("a"));
    queue.add(track("a"));
    // One entry per canonical track: the second add is a no-op, and the
    // queue ARRAY SLOT is the stable entry identity, so rejecting the add
    // cannot invalidate the first one.
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a"]);
    expectPermutation(1);
    // Shuffle requires an established current track (position >= 0),
    // matching how the UI enables it.
    queue.playAt(0);
    queue.setShuffle(true);
    queue.add(track("b"));
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(raw().currentTrack?.id).toBe("a");
    expectPermutation(2);
  });

  it("treats a merged identity re-added as the same track", () => {
    const queue = manager();
    // A merged search group carries every source in metadata.sources, so
    // re-adding the group (or one of its members) is the same track.
    const group = identityToTrack(
      mergeSourceReference(
        toTrackIdentity(track("a"), { id: "aurora-a" }),
        { source: "youtube", id: "yt-1" },
      ),
    );
    queue.add(group);
    queue.add(track("a"));
    queue.add({ ...track("yt-1"), provider: "youtube" });
    expect(raw().queue.map((entry) => entry.id)).toEqual([group.id]);
    expectPermutation(1);
  });

  it("rejects a cross-provider rendering of a queued track", () => {
    const queue = manager();
    queue.add(track("a"));
    // Same recording, different provider: an exact|strong matcher verdict,
    // so one entry. Duration is carried so the duration signal agrees.
    queue.add({
      ...track("a"),
      id: "dz-9",
      provider: "deezer",
      providerTrackId: "dz-9",
      duration: 100,
    });
    expect(raw().queue).toHaveLength(1);
    expectPermutation(1);
  });

  it("accepts TrackIdentity input", () => {
    const queue = manager();
    queue.add(toTrackIdentity(track("a"), { id: "aurora-a" }));
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("absorbs a generated batch that overlaps the queue already playing", () => {
    // Radio and keep-listening both append a batch through `add`. A batch
    // that names tracks already queued - or a cross-provider rendering of one
    // - must grow the queue by only its genuinely new tracks, which is what
    // the coordinator's excludeKeys cannot guarantee on its own (it is a
    // best-effort pre-filter, and a cross-provider hit needs the matcher).
    const queue = manager();
    for (const id of ["a", "b", "c"]) {
      queue.add(track(id));
    }
    for (const candidate of [
      track("b"),
      track("d"),
      track("c"),
      {
        ...track("a"),
        id: "dz-a",
        provider: "deezer",
        providerTrackId: "dz-a",
        duration: 180,
      },
      track("e"),
    ]) {
      queue.add(candidate);
    }
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e"]);
    expectPermutation(5);
  });

  it("keeps the play order a valid permutation after rejecting duplicates", () => {
    const queue = manager();
    manager().replace([track("a"), track("b"), track("c"), track("d")], {
      autoplay: false,
    });
    queue.playAt(0);
    queue.setShuffle(true);
    expectPermutation(4);
    const shuffled = [...raw().playOrder];

    // Two rejections, one reposition. None may disturb the permutation, and
    // none may change the current track.
    queue.add(track("c"));
    queue.add(track("a"));
    queue.playNext(track("a"));

    expectPermutation(4);
    expect(raw().queue).toHaveLength(4);
    expect(raw().currentTrack?.id).toBe("a");
    // playNext("a") is a no-op: "a" IS the cursor entry.
    expect(raw().playOrder).toEqual(shuffled);
  });
});

describe("remove", () => {
  function three() {
    manager().replace([track("a"), track("b"), track("c")], { autoplay: false });
  }

  it("removes first, middle, and last entries", () => {
    const queue = manager();
    three();
    queue.remove(2);
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a", "b"]);
    // Position 0 holds the current track, so move off it first.
    queue.playAt(1);
    queue.remove(0);
    expect(raw().queue.map((entry) => entry.id)).toEqual(["b"]);
    expect(raw().currentTrack?.id).toBe("b");
    expectPermutation(1);
  });

  it("refuses to remove the current track", () => {
    const queue = manager();
    three();
    // position 0 is current after replace with startIndex 0.
    queue.remove(0);
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
  });

  it("adjusts the current position when removing earlier entries", () => {
    const queue = manager();
    manager().replace([track("a"), track("b"), track("c")], { autoplay: false });
    queue.playAt(2);
    queue.remove(0);
    expect(raw().position).toBe(1);
    expect(raw().currentTrack?.id).toBe("c");
    expectPermutation(2);
  });

  it("keeps entries after the current position stable", () => {
    const queue = manager();
    three();
    queue.playAt(0);
    queue.remove(2);
    expect(raw().position).toBe(0);
    expect(raw().currentTrack?.id).toBe("a");
  });

  it("rejects invalid indices", () => {
    const queue = manager();
    three();
    expect(() => queue.remove(-1)).toThrow(NormalizationError);
    expect(() => queue.remove(3)).toThrow(NormalizationError);
    expect(() => queue.remove(1.5)).toThrow(NormalizationError);
    expect(raw().queue).toHaveLength(3);
  });

  it("removes on an empty queue throw", () => {
    expect(() => manager().remove(0)).toThrow(NormalizationError);
  });
});

describe("move", () => {
  function three() {
    manager().replace([track("a"), track("b"), track("c")], { autoplay: false });
  }

  it("moves first to last and last to first", () => {
    const queue = manager();
    three();
    queue.move(0, 2);
    expect(raw().playOrder.map((index) => raw().queue[index]?.id)).toEqual(["b", "c", "a"]);
    expectPermutation(3);
    queue.move(2, 0);
    expect(raw().playOrder.map((index) => raw().queue[index]?.id)).toEqual(["a", "b", "c"]);
  });

  it("tracks the current item through moves", () => {
    const queue = manager();
    three();
    queue.playAt(1);
    queue.move(1, 0);
    expect(raw().currentTrack?.id).toBe("b");
    expect(raw().position).toBe(0);
    queue.move(0, 2);
    expect(raw().currentTrack?.id).toBe("b");
    expect(raw().position).toBe(2);
    expectPermutation(3);
  });

  it("moves adjacent entries", () => {
    const queue = manager();
    three();
    queue.move(0, 1);
    expect(raw().playOrder.map((index) => raw().queue[index]?.id)).toEqual(["b", "a", "c"]);
  });

  it("treats no-op moves as silent success", () => {
    const queue = manager();
    three();
    queue.move(1, 1);
    expect(raw().playOrder).toEqual([0, 1, 2]);
  });

  it("rejects invalid positions", () => {
    const queue = manager();
    three();
    expect(() => queue.move(-1, 0)).toThrow(NormalizationError);
    expect(() => queue.move(0, 3)).toThrow(NormalizationError);
  });
});

describe("clear", () => {
  it("empties a populated queue and resets playback state", () => {
    const queue = manager();
    queue.replace([track("a"), track("b")], { autoplay: false });
    queue.clear();
    const state = raw();
    expect(state.queue).toEqual([]);
    expect(state.playOrder).toEqual([]);
    expect(state.position).toBe(-1);
    expect(state.currentTrack).toBeNull();
    expect(state.isPlaying).toBe(false);
  });

  it("clears an empty queue without error", () => {
    expect(() => manager().clear()).not.toThrow();
  });
});

describe("replace", () => {
  it("replaces with a collection at a start index", () => {
    const queue = manager();
    queue.replace([track("a"), track("b"), track("c")], { startIndex: 2, autoplay: false });
    expect(raw().currentTrack?.id).toBe("c");
    expect(raw().position).toBe(2);
    expectPermutation(3);
  });

  it("replaces with an empty list like clear", () => {
    const queue = manager();
    queue.replace([track("a")], { autoplay: false });
    queue.replace([]);
    expect(raw().queue).toEqual([]);
    expect(raw().currentTrack).toBeNull();
  });

  it("matches store.playTrack end state for single items", () => {
    manager().replace([track("a")], { autoplay: false });
    const viaManager = {
      queue: raw().queue.map((entry) => entry.id),
      position: raw().position,
      current: raw().currentTrack?.id,
    };
    resetStore();
    usePlayerStore.getState().playTrack(track("a"), { autoplay: false });
    expect({
      queue: raw().queue.map((entry) => entry.id),
      position: raw().position,
      current: raw().currentTrack?.id,
    }).toEqual(viaManager);
  });
});

describe("next and previous", () => {
  function three() {
    manager().replace([track("a"), track("b"), track("c")], { autoplay: false });
  }

  it("advances normally and stops at the end when repeat is off", () => {
    const queue = manager();
    three();
    queue.next();
    expect(raw().currentTrack?.id).toBe("b");
    queue.next();
    expect(raw().currentTrack?.id).toBe("c");
    queue.next();
    expect(raw().currentTrack?.id).toBe("c");
    expect(raw().isPlaying).toBe(false);
  });

  it("manual next advances even when repeat is track", () => {
    // Frozen semantic: repeat-one pins only natural track end
    // (afterEndQueueIndex); manual next() always advances.
    const queue = manager();
    three();
    queue.setRepeat("track");
    queue.next();
    expect(raw().currentTrack?.id).toBe("b");
  });

  it("wraps around when repeat is queue", () => {
    const queue = manager();
    three();
    queue.setRepeat("queue");
    queue.next();
    queue.next();
    queue.next();
    expect(raw().currentTrack?.id).toBe("a");
  });

  it("no-ops next on an empty queue", () => {
    expect(() => manager().next()).not.toThrow();
  });

  it("goes back within the order and restarts at the beginning", () => {
    const queue = manager();
    three();
    queue.next();
    queue.previous();
    expect(raw().currentTrack?.id).toBe("a");
    // At the beginning (or with elapsed playback) previous restarts.
    queue.previous();
    expect(raw().currentTrack?.id).toBe("a");
    expect(raw().currentTime).toBe(0);
  });

  it("restarts when playback has elapsed past the threshold", () => {
    const queue = manager();
    three();
    queue.next();
    usePlayerStore.setState({ currentTime: 10 });
    queue.previous();
    expect(raw().currentTrack?.id).toBe("b");
    expect(raw().currentTime).toBe(0);
  });

  it("follows shuffled order", () => {
    const queue = manager();
    const ids = ["a", "b", "c", "d", "e"].map((id) => track(id));
    queue.replace(ids, { autoplay: false });
    queue.setShuffle(true);
    const order = [...raw().playOrder];
    const seen: string[] = [raw().currentTrack?.id ?? ""];
    for (let i = 0; i < 4; i += 1) {
      queue.next();
      seen.push(raw().currentTrack?.id ?? "");
    }
    expect(seen).toEqual(order.map((index) => ids[index]?.id));
  });
});

describe("playAt", () => {
  it("jumps to a playOrder position", () => {
    const queue = manager();
    queue.replace([track("a"), track("b")], { autoplay: false });
    queue.playAt(1);
    expect(raw().currentTrack?.id).toBe("b");
    expect(raw().position).toBe(1);
  });

  it("rejects out-of-range positions", () => {
    const queue = manager();
    queue.replace([track("a")], { autoplay: false });
    expect(() => queue.playAt(-1)).toThrow(NormalizationError);
    expect(() => queue.playAt(1)).toThrow(NormalizationError);
    expect(raw().currentTrack?.id).toBe("a");
  });
});

describe("shuffle", () => {
  it("pins the current track and keeps a full permutation", () => {
    const queue = manager();
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => track(id));
    queue.replace(ids, { autoplay: false });
    queue.playAt(3);
    queue.setShuffle(true);
    const state = raw();
    expect(state.shuffle).toBe(true);
    expect(state.playOrder[0]).toBe(3);
    expect(state.position).toBe(0);
    expect(state.currentTrack?.id).toBe("d");
    expectPermutation(8);
  });

  it("restores sequential order with the current track stable", () => {
    const queue = manager();
    queue.replace([track("a"), track("b"), track("c")], { autoplay: false });
    queue.playAt(1);
    queue.setShuffle(true);
    queue.setShuffle(false);
    const state = raw();
    expect(state.shuffle).toBe(false);
    expect(state.playOrder).toEqual([0, 1, 2]);
    expect(state.position).toBe(1);
    expect(state.currentTrack?.id).toBe("b");
  });

  it("is a no-op setter when already in the desired state", () => {
    const queue = manager();
    queue.replace([track("a"), track("b")], { autoplay: false });
    const before = [...raw().playOrder];
    queue.setShuffle(false);
    expect(raw().playOrder).toEqual(before);
  });

  it("repeated toggling preserves all items", () => {
    const queue = manager();
    queue.replace(
      ["a", "b", "c", "d", "e"].map((id) => track(id)),
      { autoplay: false },
    );
    for (let i = 0; i < 4; i += 1) {
      queue.setShuffle(i % 2 === 0);
      expectPermutation(5);
    }
    expect(raw().currentTrack).not.toBeNull();
  });
});

describe("repeat", () => {
  it("sets each canonical mode", () => {
    const queue = manager();
    queue.setRepeat("track");
    expect(raw().repeat).toBe("one");
    queue.setRepeat("queue");
    expect(raw().repeat).toBe("all");
    queue.setRepeat("off");
    expect(raw().repeat).toBe("off");
  });

  it("rejects unknown modes", () => {
    const queue = manager();
    expect(() => queue.setRepeat("everything" as never)).toThrow(NormalizationError);
    expect(raw().repeat).toBe("off");
  });
});

describe("play and playNext", () => {
  it("play replaces the queue with a single track", () => {
    const queue = manager();
    queue.replace([track("a"), track("b")], { autoplay: false });
    queue.play(track("c"));
    expect(raw().queue.map((entry) => entry.id)).toEqual(["c"]);
    expect(raw().position).toBe(0);
  });

  it("playNext inserts after the current position without autoplay", () => {
    const queue = manager();
    queue.replace([track("a"), track("b"), track("c")], { autoplay: false });
    queue.playNext(track("x"));
    expect(raw().queue.map((entry) => entry.id)).toEqual(["a", "b", "c", "x"]);
    // Inserted directly after position 0 in playOrder.
    expect(raw().playOrder[1]).toBe(3);
    expect(raw().currentTrack?.id).toBe("a");
    expect(raw().isPlaying).toBe(false);
    expectPermutation(4);
  });
});

describe("snapshot", () => {
  it("returns copies that cannot mutate store state", () => {
    const queue = manager();
    queue.replace([track("a"), track("b")], { autoplay: false });
    const snapshot = queue.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.playOrder).toEqual([0, 1]);
    expect(snapshot.currentIndex).toBe(0);
    expect(snapshot.shuffle).toBe(false);
    expect(snapshot.repeat).toBe("off");
    (snapshot.items as Track[]).pop();
    (snapshot.playOrder as number[]).pop();
    expect(raw().queue).toHaveLength(2);
    expect(raw().playOrder).toHaveLength(2);
    expect(queue.getCurrentIndex()).toBe(0);
  });

  it("exposes the current track canonically", () => {
    const queue = manager();
    expect(queue.getCurrentTrack()).toBeNull();
    queue.replace([track("a"), track("b")], { autoplay: false });
    queue.playAt(1);
    const current = queue.getCurrentTrack();
    expect(current && "primarySource" in current ? current.primarySource.id : null).toBe("b");
  });

  it("preserves slots for unconvertible tracks without shifting indices", () => {
    const queue = manager();
    queue.replace(
      [track("a"), { ...track("b"), provider: "jamendo" }],
      { autoplay: false },
    );
    const snapshot = queue.getSnapshot();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.playOrder).toEqual([0, 1]);
  });
});

describe("boundary matrix", () => {
  it("handles empty-queue operations safely", () => {
    const queue = manager();
    expect(queue.getSnapshot().items).toEqual([]);
    expect(queue.getCurrentTrack()).toBeNull();
    expect(queue.getCurrentIndex()).toBe(-1);
    queue.next();
    queue.previous();
    expect(raw().queue).toEqual([]);
  });

  it("handles single-item queues", () => {
    const queue = manager();
    queue.replace([track("only")], { autoplay: false });
    queue.next();
    expect(raw().currentTrack?.id).toBe("only");
    queue.setShuffle(true);
    expectPermutation(1);
    expect(raw().currentTrack?.id).toBe("only");
  });

  it("handles large queues with permutation intact", () => {
    const queue = manager();
    const items = Array.from({ length: 100 }, (_, index) => track(`t${index}`));
    queue.replace(items, { autoplay: false });
    queue.setShuffle(true);
    expectPermutation(100);
    expect(raw().playOrder[0]).toBe(0);
    queue.setShuffle(false);
    expect(raw().playOrder).toEqual(items.map((_, index) => index));
  });

  it("preserves current identity across add, move, and unrelated remove", () => {
    const queue = manager();
    queue.replace([track("a"), track("b"), track("c")], { autoplay: false });
    queue.playAt(1);
    queue.add(track("z"));
    expect(raw().currentTrack?.id).toBe("b");
    queue.move(3, 0);
    expect(raw().currentTrack?.id).toBe("b");
    queue.remove(3);
    expect(raw().currentTrack?.id).toBe("b");
    expectPermutation(3);
  });
});
