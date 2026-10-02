import type { Track, TrackIdentity } from "@/lib/domain";
import { NormalizationError, toTrackIdentity } from "@/lib/domain";
import { identityToTrack } from "./identity-track";

/**
 * Canonical queue abstraction for the Music Engine.
 *
 * OWNERSHIP (deliberate transitional strategy): the PlayerStore remains the
 * authoritative state container. This manager owns NO queue array, NO
 * listeners, and NO duplicated logic — it is a typed orchestration facade
 * that reads fresh store state per call and delegates every mutation to the
 * existing store actions. There is exactly one mutation path
 * (QueueManager -> PlayerStore actions), so a shadow queue cannot diverge.
 *
 * A full extraction of queue semantics out of Zustand was rejected as
 * unsafe: the shuffle/repeat/navigation edge cases are covered by the
 * store's own suites, and moving them would gain no behavior while risking
 * regressions. No initialize/shutdown exists because there is nothing to
 * dispose (no subscriptions, no timers, no caches).
 *
 * INDEX SEMANTICS (frozen from the store, documented here):
 * - Public `index` arguments are positions within `playOrder`
 *   (the playback sequence), NOT raw `queue` array indices.
 * - `QueueSnapshot.playOrder` exposes the raw index mapping for
 *   transparency; `currentIndex` is the position within `playOrder`.
 * - `snapshot.items` is a canonical TrackIdentity VIEW aligned 1:1 with
 *   the raw queue: entries that fail canonicalization keep their slot as
 *   the original Track (never dropped, never reordered), so indices stay
 *   stable. Callers needing strict identities filter by shape.
 */

export type QueueRepeatMode = "off" | "track" | "queue";

export type QueueSnapshotItem = TrackIdentity | Track;

export interface QueueSnapshot {
  /** Canonical view, 1:1 aligned with the raw queue order. */
  items: readonly QueueSnapshotItem[];
  /** Raw playOrder mapping (indices into the queue array). Read-only copy. */
  playOrder: readonly number[];
  /** Position within playOrder of the current track. */
  currentIndex: number;
  shuffle: boolean;
  repeat: QueueRepeatMode;
}

/**
 * The order fields of a snapshot, without the queue view.
 *
 * `getSnapshot()` is O(n) in the queue because `items` maps every entry to a
 * canonical identity (and mints an id per entry). Callers that only read
 * cursor/shuffle/repeat/order — the engine's snapshot builder, and the
 * `queue.length` / `queue.playOrder` accessors — must not pay that, and they
 * run on every store notification for every subscriber. This is the same
 * fields, read straight off the store.
 */
export interface QueueOrderState {
  playOrder: readonly number[];
  currentIndex: number;
  shuffle: boolean;
  repeat: QueueRepeatMode;
}

export interface QueueStoreState {
  queue: Track[];
  playOrder: number[];
  position: number;
  shuffle: boolean;
  repeat: "off" | "one" | "all";
  currentTrack: Track | null;
}

export interface QueueStoreActions {
  playTrack(track: Track, options?: { autoplay?: boolean }): void;
  replaceQueue(
    tracks: Track[],
    options?: { startIndex?: number; autoplay?: boolean; preserveCurrent?: boolean },
  ): void;
  playCollection(tracks: Track[], startIndex?: number): void;
  playNext(track: Track): void;
  addToQueue(track: Track): void;
  playAtPosition(position: number): void;
  next(): void;
  prev(): void;
  clearQueue(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  moveQueueItem(position: number, direction: "up" | "down"): void;
  removeFromQueue(position: number): void;
}

export interface QueueManagerDeps {
  /** Fresh store state per call (never a captured snapshot). */
  getState: () => QueueStoreState;
  /** Stable store action closures. */
  actions: QueueStoreActions;
}

export interface ReplaceOptions {
  startIndex?: number;
  autoplay?: boolean;
}

export interface QueueManager {
  getSnapshot(): QueueSnapshot;
  /** Order fields only — O(order), with no per-entry canonicalization. */
  getOrderState(): QueueOrderState;
  getCurrentTrack(): QueueSnapshotItem | null;
  getCurrentIndex(): number;
  play(track: TrackIdentity | Track, options?: { autoplay?: boolean }): void;
  add(track: TrackIdentity | Track): void;
  playNext(track: TrackIdentity | Track): void;
  replace(items: Array<TrackIdentity | Track>, options?: ReplaceOptions): void;
  remove(index: number): void;
  move(from: number, to: number): void;
  clear(): void;
  playAt(index: number): void;
  next(): void;
  previous(): void;
  setShuffle(enabled: boolean): void;
  setRepeat(mode: QueueRepeatMode): void;
}

function toTrackItem(item: TrackIdentity | Track): Track {
  return Array.isArray((item as Partial<TrackIdentity>).sources)
    ? identityToTrack(item as TrackIdentity)
    : (item as Track);
}

function toSnapshotItem(track: Track): QueueSnapshotItem {
  try {
    return toTrackIdentity(track);
  } catch {
    // Alignment over purity: keep the slot so indices never shift.
    return track;
  }
}

function checkIndex(length: number, index: number, name: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= length) {
    throw new NormalizationError(name, `Queue index out of range: ${index}`);
  }
}

export function createQueueManager(deps: QueueManagerDeps): QueueManager {
  const { getState, actions } = deps;

  function repeatModeOf(repeat: QueueStoreState["repeat"]): QueueRepeatMode {
    return repeat === "one" ? "track" : repeat === "all" ? "queue" : "off";
  }

  function orderState(): QueueOrderState {
    const state = getState();
    return {
      playOrder: [...state.playOrder],
      currentIndex: state.position,
      shuffle: state.shuffle,
      repeat: repeatModeOf(state.repeat),
    };
  }

  function snapshot(): QueueSnapshot {
    const order = orderState();
    return {
      items: getState().queue.map(toSnapshotItem),
      playOrder: order.playOrder,
      currentIndex: order.currentIndex,
      shuffle: order.shuffle,
      repeat: order.repeat,
    };
  }

  return {
    getSnapshot(): QueueSnapshot {
      return snapshot();
    },

    getOrderState(): QueueOrderState {
      return orderState();
    },

    getCurrentTrack(): QueueSnapshotItem | null {
      const track = getState().currentTrack;
      return track ? toSnapshotItem(track) : null;
    },

    getCurrentIndex(): number {
      return getState().position;
    },

    play(track: TrackIdentity | Track, options: { autoplay?: boolean } = {}): void {
      // Behavior-identical to store.playTrack: replace with a single item.
      actions.replaceQueue([toTrackItem(track)], {
        startIndex: 0,
        autoplay: options.autoplay ?? true,
      });
    },

    add(track: TrackIdentity | Track): void {
      actions.addToQueue(toTrackItem(track));
    },

    playNext(track: TrackIdentity | Track): void {
      actions.playNext(toTrackItem(track));
    },

    replace(
      items: Array<TrackIdentity | Track>,
      options: ReplaceOptions = {},
    ): void {
      actions.replaceQueue(items.map(toTrackItem), {
        startIndex: options.startIndex ?? 0,
        autoplay: options.autoplay ?? true,
      });
    },

    remove(index: number): void {
      checkIndex(getState().playOrder.length, index, "index");
      actions.removeFromQueue(index);
    },

    move(from: number, to: number): void {
      const length = getState().playOrder.length;
      checkIndex(length, from, "from");
      checkIndex(length, to, "to");
      if (from === to) {
        return;
      }
      // moveQueueItem swaps one adjacent step; walk toward the target.
      // Identical walk to the previous facade so reorder semantics match.
      const step: "up" | "down" = to < from ? "up" : "down";
      let current = from;
      while (current !== to) {
        actions.moveQueueItem(current, step);
        current += step === "up" ? -1 : 1;
      }
    },

    clear(): void {
      actions.clearQueue();
    },

    playAt(index: number): void {
      checkIndex(getState().playOrder.length, index, "index");
      actions.playAtPosition(index);
    },

    next(): void {
      actions.next();
    },

    previous(): void {
      actions.prev();
    },

    setShuffle(enabled: boolean): void {
      if (getState().shuffle !== enabled) {
        actions.toggleShuffle();
      }
    },

    setRepeat(mode: QueueRepeatMode): void {
      if (mode !== "off" && mode !== "track" && mode !== "queue") {
        throw new NormalizationError("mode", `Invalid repeat mode: ${mode}`);
      }
      const target = mode === "off" ? "off" : mode === "track" ? "one" : "all";
      // Cycle at most twice; the store cycles off -> all -> one -> off.
      for (let i = 0; i < 3 && getState().repeat !== target; i += 1) {
        actions.cycleRepeat();
      }
    },
  };
}
