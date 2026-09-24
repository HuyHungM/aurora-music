import type { SerializedEngineError, TrackIdentity } from "@/lib/domain";
import type { MusicEngineState } from "./music-engine";

/**
 * Typed event system for the MusicEngine facade.
 *
 * Small, dependency-free, and UI-independent. Listener failures are
 * isolated per listener so one bad subscriber can never break playback;
 * a throwing listener is reported once through the `error` event, with a
 * recursion guard so error reporting can never storm.
 */

export type TrackEndReason = "natural" | "skip" | "stop";

export interface MusicEngineEvents {
  trackStart: {
    track: TrackIdentity;
    index: number;
  };
  trackEnd: {
    track: TrackIdentity;
    index: number;
    reason: TrackEndReason;
  };
  trackError: {
    track?: TrackIdentity;
    error: SerializedEngineError;
  };
  queueEnd: {
    queue: readonly TrackIdentity[];
  };
  error: {
    error: SerializedEngineError;
  };
  /**
   * Reactive state broadcast for UI bindings. Emitted after every store
   * change observed by the facade (including high-frequency progress
   * ticks); subscribers select narrow slices so unrelated updates skip
   * re-renders. Carries the memoized facade snapshot, never internals.
   */
  stateChange: {
    state: MusicEngineState;
  };
}

export type MusicEngineEventName = keyof MusicEngineEvents;

export type MusicEngineListener<T extends MusicEngineEventName> = (
  payload: MusicEngineEvents[T],
) => void;

export type MusicEngineAnyListener = (
  event: MusicEngineEventName,
  payload: MusicEngineEvents[MusicEngineEventName],
) => void;

export interface MusicEventEmitter {
  on<T extends MusicEngineEventName>(
    event: T,
    listener: MusicEngineListener<T>,
  ): () => void;
  off<T extends MusicEngineEventName>(
    event: T,
    listener: MusicEngineListener<T>,
  ): void;
  subscribe(listener: MusicEngineAnyListener): () => void;
  emit<T extends MusicEngineEventName>(
    event: T,
    payload: MusicEngineEvents[T],
  ): void;
  listenerCount(): number;
  clear(): void;
}

function toErrorPayload(error: unknown): SerializedEngineError {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return {
      name: "ListenerError",
      code: "ENGINE_ERROR",
      message: (error as { message: string }).message,
      retryable: false,
    };
  }
  return {
    name: "ListenerError",
    code: "ENGINE_ERROR",
    message: "Event listener failed",
    retryable: false,
  };
}

export function createMusicEventEmitter(): MusicEventEmitter {
  const specific = new Map<
    MusicEngineEventName,
    Set<(payload: never) => void>
  >();
  const global = new Set<MusicEngineAnyListener>();
  let emittingError = false;

  function listenersFor(event: MusicEngineEventName): Array<(payload: never) => void> {
    return [...(specific.get(event) ?? [])];
  }

  function reportListenerFailure(event: MusicEngineEventName, error: unknown): void {
    if (event === "error" || emittingError) {
      return;
    }
    emittingError = true;
    try {
      const payload: MusicEngineEvents["error"] = { error: toErrorPayload(error) };
      for (const listener of listenersFor("error")) {
        try {
          listener(payload as never);
        } catch {
          // Already reporting: never recurse.
        }
      }
      for (const anyListener of [...global]) {
        try {
          anyListener("error", payload);
        } catch {
          // Already reporting: never recurse.
        }
      }
    } finally {
      emittingError = false;
    }
  }

  return {
    on(event, listener) {
      let set = specific.get(event);
      if (!set) {
        set = new Set();
        specific.set(event, set);
      }
      set.add(listener as (payload: never) => void);
      return () => {
        specific.get(event)?.delete(listener as (payload: never) => void);
      };
    },

    off(event, listener) {
      specific.get(event)?.delete(listener as (payload: never) => void);
    },

    subscribe(listener) {
      global.add(listener);
      return () => {
        global.delete(listener);
      };
    },

    emit(event, payload) {
      const failures: unknown[] = [];
      for (const listener of listenersFor(event)) {
        try {
          listener(payload as never);
        } catch (error) {
          failures.push(error);
        }
      }
      for (const anyListener of [...global]) {
        try {
          anyListener(event, payload);
        } catch (error) {
          failures.push(error);
        }
      }
      for (const failure of failures) {
        reportListenerFailure(event, failure);
      }
    },

    listenerCount() {
      let count = global.size;
      for (const set of specific.values()) {
        count += set.size;
      }
      return count;
    },

    clear() {
      specific.clear();
      global.clear();
    },
  };
}
