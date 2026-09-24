import { vi } from "vitest";
import type { AudioSource, Track } from "@/lib/domain";
import { PlaybackResolutionError } from "@/lib/domain";
import type { PlayerError } from "@/lib/player/engine";
import type {
  ControllerEngine,
  ControllerEngineEvent,
  ControllerEngineEventPayload,
  RecoverySchedule,
} from "@/lib/playback/controller";
import type { PlaybackResolver, SourcePlaybackResolver } from "@/lib/playback/resolver";

/**
 * Test-only controller environment: fake engine + controllable resolver.
 * No network, no DOM audio, no store.
 */

export interface FakeEngine extends ControllerEngine {
  loaded: Array<{ track: Track; autoplay: boolean }>;
  playCalls: number;
  pauseCalls: number;
  seeks: number[];
  failPlayWith: Error | null;
  /** Element position/duration reported by snapshot(). */
  position: number;
  sourceDuration: number;
  emitError(payload?: { error?: PlayerError }): void;
  emit(event: ControllerEngineEvent, payload?: ControllerEngineEventPayload): void;
  listenerCount(event: ControllerEngineEvent): number;
}

export function fakeEngine(): FakeEngine {
  const listeners = new Map<
    ControllerEngineEvent,
    Set<(payload: ControllerEngineEventPayload) => void>
  >();
  const env: FakeEngine = {
    loaded: [],
    playCalls: 0,
    pauseCalls: 0,
    seeks: [],
    failPlayWith: null,
    position: 0,
    sourceDuration: 0,
    load(track: Track, autoplay: boolean): void {
      env.loaded.push({ track, autoplay });
    },
    async play(): Promise<void> {
      env.playCalls += 1;
      if (env.failPlayWith) {
        throw env.failPlayWith;
      }
    },
    pause(): void {
      env.pauseCalls += 1;
    },
    seek(seconds: number): void {
      env.seeks.push(seconds);
    },
    snapshot(): { currentTime: number; duration: number } {
      return { currentTime: env.position, duration: env.sourceDuration };
    },
    on(
      event: ControllerEngineEvent,
      listener: (payload: ControllerEngineEventPayload) => void,
    ): () => void {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
    emit(event: ControllerEngineEvent, payload: ControllerEngineEventPayload = {}): void {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(payload);
      }
    },
    emitError(payload: { error?: PlayerError } = {}): void {
      env.emit("error", payload);
    },
    listenerCount(event: ControllerEngineEvent): number {
      return listeners.get(event)?.size ?? 0;
    },
  };
  return env;
}

export function youtubeTrack(id = "dQw4w9WgXcQ"): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: "Song",
    artistId: "UC1",
    artistName: "Artist",
  };
}

export function spotifyTrack(): Track {
  return {
    id: "spotify-1",
    provider: "spotify",
    providerTrackId: "spotify-1",
    title: "Song",
    artistId: "sa-1",
    artistName: "Artist",
    previewUrl: "https://preview.example/spotify-1.mp3",
  };
}

export function sourceFor(videoId: string, url = `https://cdn.example/${videoId}.m4a`): AudioSource {
  return { url, mimeType: "audio/mp4", durationMs: 213_000 };
}

export interface ControllableResolver {
  resolver: PlaybackResolver;
  resolveSource: ReturnType<typeof vi.fn<SourcePlaybackResolver["resolveSource"]>>;
  rejectNextWith(error: unknown): void;
  resolveNextWith(source: AudioSource): void;
}

export function controllableResolver(): ControllableResolver {
  let next: { ok: true; source: AudioSource } | { ok: false; error: unknown } | null = null;
  const resolveSource = vi.fn<SourcePlaybackResolver["resolveSource"]>(async () => {
    if (!next) {
      throw new PlaybackResolutionError(
        { provider: "youtube", providerTrackId: "dQw4w9WgXcQ" },
        "resolve",
        "No stubbed resolution",
      );
    }
    const current = next;
    next = null;
    if (current.ok) {
      return current.source;
    }
    throw current.error;
  });
  return {
    resolveSource,
    resolver: {
      // Mirrors production semantics: only youtube sources are resolvable.
      canResolve: (identity) =>
        identity.sources.some((source) => source.source === "youtube"),
      resolve: async (identity) => {
        const ref = identity.sources.find((source) => source.source === "youtube");
        if (!ref) {
          throw new PlaybackResolutionError(
            { provider: "spotify", providerTrackId: "x" },
            "match",
            "No playable source in this identity",
          );
        }
        return resolveSource(ref);
      },
    },
    rejectNextWith(error: unknown): void {
      next = { ok: false, error };
    },
    resolveNextWith(source: AudioSource): void {
      next = { ok: true, source };
    },
  };
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deterministic clock for stall/backoff timing. */
export interface ManualClock {
  now: () => number;
  advance(ms: number): void;
}

export function manualClock(start = 1_000_000): ManualClock {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Deterministic scheduler: callbacks run only when the test fires them. */
export interface ManualScheduler {
  schedule: RecoverySchedule;
  pending: Array<{ callback: () => void; delayMs: number; cancelled: boolean }>;
  /** Run the oldest pending callback (throws when none pending). */
  runNext(): void;
  runAll(): void;
  pendingCount(): number;
}

export function manualScheduler(): ManualScheduler {
  const pending: ManualScheduler["pending"] = [];
  const scheduler: ManualScheduler = {
    schedule: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    pending,
    runNext(): void {
      const next = pending.find((entry) => !entry.cancelled);
      if (!next) {
        throw new Error("manualScheduler.runNext: nothing pending");
      }
      next.cancelled = true;
      next.callback();
    },
    runAll(): void {
      let guard = 0;
      while (pending.some((entry) => !entry.cancelled)) {
        guard += 1;
        if (guard > 100) {
          throw new Error("manualScheduler.runAll: possible infinite loop");
        }
        scheduler.runNext();
      }
    },
    pendingCount(): number {
      return pending.filter((entry) => !entry.cancelled).length;
    },
  };
  return scheduler;
}
