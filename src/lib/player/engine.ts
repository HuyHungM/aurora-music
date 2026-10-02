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
 * Read-only view of the media element, for observing real playback.
 *
 * Deliberately excludes `src`: see `PlayerEngine.mediaDiagnostics`. Every field
 * is either a number or a boolean so the snapshot is JSON-safe.
 */
export interface MediaDiagnostics {
  /** A source has been assigned. Says nothing about which one. */
  hasSource: boolean;
  /** Scheme of the assigned source ONLY: "blob" | "https" | "http" | "data". */
  sourceScheme: string | null;
  /** HAVE_* level. >= 2 means there is playable data at the current time. */
  readyState: number | null;
  networkState: number | null;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  currentTime: number;
  /** 0 when unknown or not yet known, which is normal before metadata loads. */
  duration: number;
  /** `MediaError.code`, or null. 2 = network, 3 = decode, 4 = src not supported. */
  errorCode: number | null;
  /**
   * `MediaError.message`, sanitized and bounded, or null.
   *
   * This is the field that makes a media failure diagnosable. `errorCode` alone
   * cannot separate the causes that all arrive as code 4: a revoked blob URL
   * reports "Media load rejected by URL safety check", an empty file reports
   * "Format error", and an undecodable container reports a demuxer failure.
   * Every one of them is code 4, so without this the log cannot say which
   * happened.
   *
   * Sanitized because the browser does not fully author this string and other
   * engines do include source detail in it: see `safeMediaErrorMessage`.
   */
  errorMessage: string | null;
}

/** Longest `MediaError.message` retained. Enough for Chromium's boilerplate. */
const MAX_ERROR_MESSAGE = 160;

/**
 * Reduces `MediaError.message` to bounded, non-identifying text.
 *
 * WHAT THIS HAS TO SURVIVE. The message is the one genuinely useful part of a
 * media failure and the one field the browser does not fully control: Chromium
 * emits fixed boilerplate, but other engines have been observed to include the
 * offending source in the text. So the value is kept only when it looks like the
 * boilerplate it is meant to be, and anything URL-shaped, path-shaped, or long
 * enough to be an opaque token is redacted rather than trusted.
 *
 * Redaction is deliberately conservative. A redacted message still separates
 * "revoked" from "format error" from "demuxer", which is the whole point of
 * capturing it.
 */
export function safeMediaErrorMessage(message: unknown): string | null {
  if (typeof message !== "string") {
    return null;
  }
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return "[redacted: url-shaped]";
  if (/\bblob:/i.test(trimmed)) return "[redacted: url-shaped]";
  if (/\b[a-z]:[\\/]/i.test(trimmed)) return "[redacted: path-shaped]";
  if (/(^|\s)\/(?:[\w.-]+\/){2,}/.test(trimmed)) return "[redacted: path-shaped]";
  if (/[A-Za-z0-9_-]{32,}/.test(trimmed)) return "[redacted: opaque token]";
  return trimmed.slice(0, MAX_ERROR_MESSAGE);
}

/**
 * The scheme of a source URL, or null.
 *
 * Deliberately stops at the colon. A `blob:` or signed googlevideo URL must
 * never be reachable from a value a log or a test can print, and "is this local
 * or remote" is the only question the scheme answers.
 */
export function sourceSchemeOf(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return match?.[1]?.toLowerCase() ?? null;
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

    // Same track, same URL, element already playing it: re-assigning src and
    // calling load() would audibly restart playback for no reason (the
    // controller's same-source reuse path reaches here on re-click). The
    // element is left untouched and only the autoplay intent applies. A paused
    // or errored element takes the full path, so re-click-to-restart and
    // retry-after-error semantics are unchanged.
    if (
      this.loadedKey === trackKey(track) &&
      !this.surface.paused &&
      this.surface.src === url
    ) {
      if (autoplay) {
        void this.playAutoplay();
      }
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
      error?: Partial<{ code: number; message?: unknown }> | null;
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
    // code, the sanitized native message, the source SCHEME and element state.
    // Never the source URL, tokens, or headers — the logger redacts URL-shaped
    // values as a second line of defense.
    //
    // The message is what turns a category into a diagnosis: code 4 alone covers
    // a revoked blob URL, an empty file and an undecodable container alike, and
    // all three used to look identical here.
    logger.warn("Playback media element error", {
      event: "playback_media_error",
      mediaCode: mediaCode ?? null,
      mediaErrorMessage: safeMediaErrorMessage(element.error?.message),
      sourceScheme: sourceSchemeOf(this.surface.src),
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

  /**
   * Read-only snapshot of the real media element.
   *
   * The element is created with `new Audio()` and is deliberately never
   * attached to the document, so no selector can observe it - which means
   * anything asserting "is it playing?" through the DOM is asserting about the
   * controls, not the media. This is the only honest way to ask.
   *
   * Read-only on purpose: it reports state and never the source. A googlevideo
   * URL is signed and short-lived, so returning `src` here would put a
   * credential-shaped string one careless log away from being printed.
   */
  mediaDiagnostics(): MediaDiagnostics {
    const element = this.surface as AudioSurface & {
      ended?: unknown;
      networkState?: unknown;
      readyState?: unknown;
      seeking?: unknown;
      error?: Partial<{ code: number; message?: unknown }> | null;
    };
    return {
      // `src` presence only, never its value: proves a source was assigned
      // without exposing the signed URL.
      hasSource: typeof this.surface.src === "string" && this.surface.src.length > 0,
      sourceScheme: sourceSchemeOf(this.surface.src),
      readyState: toSafeState(element.readyState),
      networkState: toSafeState(element.networkState),
      paused: this.surface.paused,
      ended: element.ended === true,
      seeking: element.seeking === true,
      muted: this.surface.muted,
      currentTime: Number.isFinite(this.surface.currentTime)
        ? this.surface.currentTime
        : 0,
      duration: safeDuration(this.surface.duration),
      errorCode:
        element.error && typeof element.error.code === "number"
          ? element.error.code
          : null,
      errorMessage: safeMediaErrorMessage(element.error?.message),
    };
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