import { usePlayerStore } from "./store";
import { getMusicEngine } from "@/lib/music/instance";

type StoreState = ReturnType<typeof usePlayerStore.getState>;

export type MediaSessionActionName =
  | "play"
  | "pause"
  | "previoustrack"
  | "nexttrack"
  | "seekbackward"
  | "seekforward"
  | "seekto";

export interface MediaSessionSeekDetails {
  seekOffset?: number | null;
  seekTime?: number | null;
  fastSeek?: boolean | null;
}

export interface MediaSessionArtwork {
  src: string;
  sizes?: string;
  type?: string;
}

/**
 * Minimal structural view of the Media Session surface the adapter uses.
 * Real browsers satisfy this; tests inject a recording double. Keeping our
 * own narrow interface (instead of DOM types) documents the capability
 * surface and keeps capability detection explicit per member.
 */
export interface MediaSessionLike {
  metadata: unknown;
  playbackState: string;
  setActionHandler(
    action: string,
    handler: ((details: MediaSessionSeekDetails) => void) | null,
  ): void;
  setPositionState?: (state: {
    duration: number;
    playbackRate: number;
    position: number;
  }) => void;
}

const OWNED_ACTIONS: readonly MediaSessionActionName[] = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekbackward",
  "seekforward",
  "seekto",
];

/** Default seek step (seconds) when the browser provides no offset. */
export const MEDIA_SESSION_DEFAULT_SEEK_OFFSET_S = 10;

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function artworkFor(
  artworkUrl: string | undefined,
): MediaSessionArtwork[] {
  if (!artworkUrl) {
    return [];
  }
  // One intended artwork source, exposed with size hints so the browser
  // can pick. Never invented, never a playback/stream URL.
  return [
    { src: artworkUrl, sizes: "96x96", type: "image/jpeg" },
    { src: artworkUrl, sizes: "512x512", type: "image/jpeg" },
  ];
}

function mediaSessionOf(
  navigatorObject: unknown,
): MediaSessionLike | null {
  const record =
    navigatorObject && typeof navigatorObject === "object"
      ? (navigatorObject as Record<string, unknown>)
      : null;
  const candidate = record?.mediaSession;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const session = candidate as Partial<MediaSessionLike>;
  if (typeof session.setActionHandler !== "function") {
    return null;
  }
  return session as MediaSessionLike;
}

type MetadataConstructor = new (init: {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: MediaSessionArtwork[];
}) => unknown;

function metadataConstructor(): MetadataConstructor | null {
  const globalScope = globalThis as Record<string, unknown>;
  const candidate = globalScope.MediaMetadata;
  if (typeof candidate !== "function") {
    return null;
  }
  return candidate as MetadataConstructor;
}

/**
 * Media Session adapter (Phase 19). Observes the existing player store and
 * drives the existing MusicEngine facade — it owns NO queue, resolution,
 * recovery, or provider state.
 *
 * - Observation reuses the throttled store pipeline (no extra timers).
 * - Commands call facade methods (resume/pause/skip/previous/seek), so
 *   media keys share exact UI semantics including recovery protections.
 * - All browser APIs are capability-detected; unsupported members degrade
 *   silently. Safe to call during SSR/tests (no-op without navigator).
 *
 * Lifecycle: returns a teardown that removes exactly the handlers this
 * adapter installed and unsubscribes. Metadata/playbackState are left to
 * the next mount's initial sync (no remount flicker, no stale clears).
 */
export function setupMediaSession(getState: () => StoreState) {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  const session = mediaSessionOf(navigator);
  if (!session) {
    return undefined;
  }

  const command = (fn: () => void): void => {
    try {
      fn();
    } catch {
      // Engine operations are authoritative and total for UI inputs;
      // a media-key call must never throw out of the adapter.
    }
  };

  const handlers: Record<
    MediaSessionActionName,
    (details?: MediaSessionSeekDetails) => void
  > = {
    play: () => command(() => getMusicEngine()?.resume()),
    pause: () => command(() => getMusicEngine()?.pause()),
    previoustrack: () => command(() => getMusicEngine()?.previous()),
    nexttrack: () => command(() => getMusicEngine()?.skip()),
    seekbackward: (details) =>
      command(() => {
        const engine = getMusicEngine();
        if (!engine) {
          return;
        }
        const raw = details?.seekOffset;
        const step =
          typeof raw === "number" && Number.isFinite(raw) && raw > 0
            ? raw
            : MEDIA_SESSION_DEFAULT_SEEK_OFFSET_S;
        engine.seek(engine.getState().position - step);
      }),
    seekforward: (details) =>
      command(() => {
        const engine = getMusicEngine();
        if (!engine) {
          return;
        }
        const raw = details?.seekOffset;
        const step =
          typeof raw === "number" && Number.isFinite(raw) && raw > 0
            ? raw
            : MEDIA_SESSION_DEFAULT_SEEK_OFFSET_S;
        engine.seek(engine.getState().position + step);
      }),
    seekto: (details) =>
      command(() => {
        const target = asFiniteNumber(details?.seekTime);
        // fastSeek is accepted and ignored: the engine seek path is
        // already exact-or-clamped, matching the UI slider semantics.
        if (target === null || target < 0) {
          return;
        }
        getMusicEngine()?.seek(target);
      }),
  };

  for (const action of OWNED_ACTIONS) {
    try {
      session.setActionHandler(action, (details) => {
        try {
          handlers[action](details);
        } catch {
          // Never propagate out of a browser callback.
        }
      });
    } catch {
      // Unsupported action on this browser: continue without it.
    }
  }

  // Write gates: metadata + playbackState sync on identity-relevant change;
  // position state additionally on whole-second progress. This keeps
  // browser writes at ~1Hz during playback instead of per-tick.
  let lastIdentityKey: string | null = null;
  let lastPositionKey: string | null = null;

  const trackIdentityKey = (state: StoreState): string | null => {
    const track = state.currentTrack;
    if (!track) {
      return null;
    }
    return [
      track.provider,
      track.providerTrackId ?? track.id,
      track.title,
      track.artistName,
      track.albumName ?? "",
      track.artworkUrl ?? "",
    ].join("|");
  };

  const syncIdentity = (state: StoreState): void => {
    const key = trackIdentityKey(state);
    const playing = state.currentTrack !== null && state.isPlaying;
    const identityKey = `${key ?? "none"}|${playing ? "playing" : "paused"}`;
    if (identityKey === lastIdentityKey) {
      return;
    }
    lastIdentityKey = identityKey;
    try {
      const track = state.currentTrack;
      if (!track) {
        try {
          session.metadata = null;
        } catch {
          // Some browsers reject null metadata; state below still syncs.
        }
      } else {
        const Ctor = metadataConstructor();
        if (Ctor) {
          session.metadata = new Ctor({
            title: track.title,
            artist: track.artistName,
            album: track.albumName,
            artwork: artworkFor(track.artworkUrl),
          });
        }
      }
    } catch {
      // Metadata is best-effort; playback state below still syncs.
    }
    try {
      session.playbackState = state.currentTrack
        ? state.isPlaying
          ? "playing"
          : "paused"
        : "none";
    } catch {
      // Older browsers may reject the "none" state; ignore.
    }
  };

  const syncPosition = (state: StoreState): void => {
    const setPosition = session.setPositionState;
    if (typeof setPosition !== "function") {
      return;
    }
    const duration = asFiniteNumber(state.duration);
    const position = asFiniteNumber(state.currentTime);
    if (duration === null || duration <= 0 || position === null) {
      return;
    }
    const clamped = Math.min(Math.max(position, 0), duration);
    const positionKey = [
      trackIdentityKey(state) ?? "none",
      duration,
      Math.floor(clamped),
      state.isPlaying ? "playing" : "paused",
    ].join("|");
    if (positionKey === lastPositionKey) {
      return;
    }
    lastPositionKey = positionKey;
    try {
      setPosition.call(session, {
        duration,
        playbackRate: 1,
        position: clamped,
      });
    } catch {
      // Browsers may reject edge values despite validation; ignore.
    }
  };

  const sync = (state: StoreState): void => {
    syncIdentity(state);
    syncPosition(state);
  };

  const unsubscribe = usePlayerStore.subscribe((state) => {
    sync(state);
  });
  sync(getState());

  return () => {
    unsubscribe();
    for (const action of OWNED_ACTIONS) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // Tearing down must not throw.
      }
    }
  };
}
