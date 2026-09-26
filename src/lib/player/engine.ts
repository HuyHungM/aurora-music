import type { Track } from "@/lib/domain";
import { logger } from "@/lib/diagnostics/logger";
import { trackKey } from "./identity";

/**
 * Player error kinds surfaced to the UI. Messages are user-safe: they never
 * contain browser exception stacks or provider secrets.
 */
export type PlayerErrorKind = "unavailable" | "playback" | "autoplay";

/**
 * HTMLMediaElement error codes (MEDIA_ERR_*). Carried for controller-side
 * failure classification only — never serialized to the UI or MusicEngine.
 */
export type MediaErrorCode = 1 | 2 | 3 | 4;

export class PlayerError extends Error {
  constructor(
    readonly kind: PlayerErrorKind,
    message: string,
    readonly mediaCode?: MediaErrorCode,
  ) {
    super(message);
    this.name = "PlayerError";
  }
}

export type EngineEvent =
  | "loadedmetadata"
  | "durationchange"
  | "timeupdate"
  | "play"
  | "playing"
  | "pause"
  | "waiting"
  | "stalled"
  | "canplay"
  | "ended"
  | "error";

export interface EngineEventPayload {
  currentTime?: number;
  duration?: number;
  error?: PlayerError;
}

export type EngineListener = (payload: EngineEventPayload) => void;

/**
 * The subset of HTMLAudioElement the engine interacts with, expressed as an
 * interface so tests can inject a fake media element.
 */
export interface AudioSurface {
  src: string;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  paused: boolean;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, handler: (event: Event) => void): void;
  removeEventListener(type: string, handler: (event: Event) => void): void;
}

/**
 * How often `timeupdate` events are relayed to listeners to avoid excessive
 * React re-renders (spec phase 5, §11/§38).
 */
export const TIMEUPDATE_THROTTLE_MS = 250;

function safeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Coerces element state integers for diagnostics. Non-finite or missing
 * values collapse to null so logs stay JSON-safe and leak-free.
 */
function toSafeState(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Single persistent audio engine per application session. Owns one media
 * element; changing tracks mutates `src` and calls `load()` rather than
 * creating new elements (spec phase 5, §7-§8). Listener cleanup is idempotent
 * and safe under React StrictMode double-mount (spec §39).
 */
export class PlayerEngine {
  private readonly surface: AudioSurface;
  private readonly listeners = new Map<EngineEvent, Set<EngineListener>>();
  private readonly mediaHandlers: Record<string, (event: Event) => void>;
  private generation = 0;
  private lastTimeupdateAt = 0;
  private attached = false;
  private loadedKey: string | null = null;

  constructor(surface: AudioSurface) {
    this.surface = surface;
    this.mediaHandlers = {
      timeupdate: () => this.handleTimeupdate(),
      loadedmetadata: () => this.handleLoadedMetadata(),
      durationchange: () => this.handleDurationChange(),
      play: () => this.emit("play"),
      playing: () => this.emit("playing"),
      pause: () => this.emit("pause"),
      waiting: () => this.emit("waiting"),
      stalled: () => this.emit("stalled"),
      canplay: () => this.emit("canplay"),
      ended: () => this.emit("ended"),
      error: () => this.handleError(),
    };
    this.attachMediaHandlers();
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /**
   * The underlying element, but only if it really is one (Phase 53 addendum).
   *
   * The equalizer needs a `MediaElementAudioSourceNode`, and the only element
   * it is allowed to use is this one. It is exposed through a narrow read-only
   * accessor rather than by widening `AudioSurface` or handing the surface out,
   * for two reasons.
   *
   * First, the return type is `HTMLAudioElement | null` rather than
   * `AudioSurface`. The surface is an interface precisely so tests can inject
   * `fake-audio.ts`; a test double is not an `HTMLAudioElement` and cannot be
   * connected to Web Audio, so the honest answer for a doubled surface is
   * `null` - which the equalizer treats as "unsupported" and leaves playback
   * alone. Returning the surface and letting each caller check would push that
   * decision into every caller.
   *
   * Second, this is the ONLY way out of the engine. Nothing in the engine knows
   * the equalizer exists, no playback code path reads EQ state, and there is no
   * second element: `getDefaultEngine()` already guarantees one. A track change,
   * a queue transition or a resolver retry goes through `load()`, which swaps
   * `src` on this same element, so the graph the EQ attached to is unaffected
   * and the EQ cannot be reset by playback.
   */
  get mediaElement(): HTMLAudioElement | null {
    if (typeof HTMLAudioElement === "undefined") {
      return null;
    }
    return this.surface instanceof HTMLAudioElement ? this.surface : null;
  }

  /** Current element time/duration snapshot (for seek and progress rendering). */
  snapshot(): { currentTime: number; duration: number } {
    return {
      currentTime: this.surface.currentTime,
      duration: safeDuration(this.surface.duration),
    };
  }

  /** Loads a track; no-op autoplay until [autoplay] is requested. */
  load(track: Track, autoplay = false): void {
    this.generation += 1;
    const url = streamUrlOf(track);

    if (!url) {
      this.loadedKey = null;
      this.surface.pause();
      this.emit("error", {
        error: new PlayerError(
          "unavailable",
          "This track has no playable stream right now.",
        ),
      });
      return;
    }

    this.loadedKey = trackKey(track);
    this.surface.src = url;
    this.surface.load();

    if (autoplay) {
      void this.playAutoplay();
    }
  }

  /** Autoplay path: media errors are relayed as events, never thrown. */
  private async playAutoplay(): Promise<void> {
    try {
      await this.attemptPlay();
    } catch (error) {
      if (error instanceof PlayerError) {
        this.emit("error", { error });
      }
    }
  }

  /** Requests media playback; rejects with a normalized PlayerError. */
  async play(): Promise<void> {
    await this.attemptPlay();
  }

  private async attemptPlay(): Promise<void> {
    try {
      await this.surface.play();
    } catch (error) {
      if (isNotAllowedError(error)) {
        this.emit("pause");
        throw new PlayerError(
          "autoplay",
          "Playback was blocked by the browser. Tap play again to start.",
        );
      }
      if (isAbortError(error)) {
        this.emit("pause");
        return;
      }
      this.emit("error", {
        error: new PlayerError("playback", "Playback failed unexpectedly."),
      });
      throw new PlayerError("playback", "Playback failed unexpectedly.");
    }
  }

  pause(): void {
    this.surface.pause();
  }

  /** Clamps into [0, duration]; silently ignores seeks before metadata loads. */
  seek(seconds: number): void {
    const duration = safeDuration(this.surface.duration);
    if (!Number.isFinite(seconds)) {
      return;
    }
    const target = duration > 0 ? Math.min(Math.max(seconds, 0), duration) : Math.max(seconds, 0);
    this.surface.currentTime = target;
    this.handleTimeupdate();
  }

  /** Clamps into [0, 1]; never mutates mute state. */
  setVolume(value: number): void {
    const clamped = clampUnit(value);
    this.surface.volume = clamped;
  }

  toggleMute(): void {
    this.surface.muted = !this.surface.muted;
  }

  /** Current element mute state (restore/idempotent set path). */
  isMuted(): boolean {
    return this.surface.muted;
  }

  on(event: EngineEvent, listener: EngineListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  off(event: EngineEvent, listener: EngineListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  /**
   * Detaches all media listeners and halts playback. Must be callable more than
   * once without side effects (StrictMode safety).
   */
  cleanup(): void {
    this.generation += 1;
    if (this.attached) {
      for (const [type, handler] of Object.entries(this.mediaHandlers)) {
        this.surface.removeEventListener(type, handler);
      }
      this.attached = false;
    }
    this.loadedKey = null;
    try {
      this.surface.pause();
      this.surface.src = "";
    } catch {
      // Surface may already be detached; nothing else to do.
    }
    this.listeners.clear();
    this.lastTimeupdateAt = 0;
  }

  private attachMediaHandlers(): void {
    if (this.attached) {
      return;
    }
    for (const [type, handler] of Object.entries(this.mediaHandlers)) {
      this.surface.addEventListener(type, handler);
    }
    this.attached = true;
  }

  private handleTimeupdate(): void {
    const now = Date.now();
    if (now - this.lastTimeupdateAt < TIMEUPDATE_THROTTLE_MS) {
      return;
    }
    this.lastTimeupdateAt = now;
    this.emit("timeupdate", { currentTime: this.surface.currentTime });
  }

  private handleLoadedMetadata(): void {
    this.emit("loadedmetadata", {
      currentTime: this.surface.currentTime,
      duration: safeDuration(this.surface.duration),
    });
  }

  private handleDurationChange(): void {
    this.emit("durationchange", {
      currentTime: this.surface.currentTime,
      duration: safeDuration(this.surface.duration),
    });
  }

  private handleError(): void {
    const element = this.surface as AudioSurface & {
      error?: Partial<{ code: number }> | null;
      networkState?: unknown;
      readyState?: unknown;
    };
    const code = element.error?.code;
    // MEDIA_ERR_ABORTED (1) means the fetch was superseded — almost always
    // by our own src change — not a playback failure. Emitting here would
    // manufacture a spurious failure (and recovery attempt) on every
    // programmatic source swap.
    if (code === 1) {
      return;
    }
    // 4 = SRC_NOT_SUPPORTED (fresh resolution may pick another format),
    // 3 = DECODE, 2 = NETWORK. The numeric code travels on the error for
    // controller classification; UI/store/facade only ever see kind+message.
    const mediaCode: MediaErrorCode | undefined =
      code === 2 || code === 3 || code === 4 ? code : undefined;
    const kind: PlayerErrorKind = code === 4 ? "unavailable" : "playback";
    // Safe failure diagnostics (Phase 25 allowlist): the numeric media
    // code plus element state. Never the source URL, tokens, or headers —
    // the logger redacts URL-shaped values as a second line of defense.
    logger.warn("Playback media element error", {
      event: "playback_media_error",
      mediaCode: mediaCode ?? null,
      networkState: toSafeState(element.networkState),
      readyState: toSafeState(element.readyState),
    });
    this.emit("error", {
      error: new PlayerError(
        kind,
        kind === "unavailable"
          ? "This stream could not be played."
          : "The stream failed while loading or playing.",
        mediaCode,
      ),
    });
  }

  private emit(event: EngineEvent, payload: EngineEventPayload = {}): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of set) {
      listener(payload);
    }
  }
}

function streamUrlOf(track: Track): string | undefined {
  return track.streamUrl ?? track.previewUrl;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

function isNotAllowedError(error: unknown): boolean {
  // ONLY user-activation policy blocks qualify. NotSupportedError means
  // the media resource itself is not supported (a source condition, not
  // a missing gesture) and must never surface as "blocked by the browser".
  return error instanceof DOMException && error.name === "NotAllowedError";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export { streamUrlOf, clampUnit };