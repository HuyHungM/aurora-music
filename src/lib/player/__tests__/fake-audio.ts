import { vi } from "vitest";
import type { AudioSurface } from "@/lib/player/engine";

type Handler = (event: Event) => void;

/**
 * Deterministic HTMLMediaElement stand-in for player tests. Events are
 * dispatched manually so tests control load/play timing explicitly.
 */
export class FakeAudioSurface implements AudioSurface {
  src = "";
  currentTime = 0;
  duration = 0;
  volume = 1;
  muted = false;
  paused = true;
  error: { code: number } | null = null;

  loadCalls = 0;
  playedCalls = 0;
  pausedCalls = 0;

  playImplementation: (surface: FakeAudioSurface) => Promise<void> = async (surface) => {
    surface.paused = false;
    queueMicrotask(() => surface.dispatch(EventEnum.playing));
  };

  readonly #handlers = new Map<string, Set<Handler>>();

  readonly play = vi.fn(async () => {
    this.playedCalls += 1;
    await this.playImplementation(this);
  });

  readonly pause = vi.fn(() => {
    this.pausedCalls += 1;
    this.paused = true;
    this.dispatch(EventEnum.pause);
  });

  readonly load = vi.fn(() => {
    this.loadCalls += 1;
  });

  readonly addEventListener = vi.fn((type: string, handler: Handler) => {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
  });

  readonly removeEventListener = vi.fn((type: string, handler: Handler) => {
    this.#handlers.get(type)?.delete(handler);
  });

  dispatch(type: string): void {
    const set = this.#handlers.get(type);
    if (!set) {
      return;
    }
    const event = new Event(type);
    for (const handler of [...set]) {
      handler(event);
    }
  }

  get listenerCount(): number {
    let count = 0;
    for (const set of this.#handlers.values()) {
      count += set.size;
    }
    return count;
  }

  failsWith(playError?: unknown, loadWithError?: { code: number }): void {
    this.playImplementation = async () => {
      if (playError) {
        throw playError;
      }
      this.paused = false;
      this.dispatch(EventEnum.playing);
    };
    this.error = loadWithError ?? null;
  }
}

export const EventEnum = {
  timeupdate: "timeupdate",
  loadedmetadata: "loadedmetadata",
  durationchange: "durationchange",
  play: "play",
  playing: "playing",
  pause: "pause",
  waiting: "waiting",
  stalled: "stalled",
  canplay: "canplay",
  ended: "ended",
  error: "error",
} as const;

export function makePlayableTrack(id = "t1", overrides: Record<string, unknown> = {}) {
  return {
    id,
    provider: "jamendo" as const,
    title: `Track ${id}`,
    artistId: "a1",
    artistName: "Artist",
    streamUrl: `https://audio.example/${id}.mp3`,
    ...overrides,
  };
}