import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PlayerEngine,
  PlayerError,
  safeMediaErrorMessage,
  sourceSchemeOf,
} from "@/lib/player/engine";
import type { EngineEvent } from "@/lib/player/engine";
import { setLogLevel, setLogSink } from "@/lib/diagnostics/logger";
import type { LogRecord } from "@/lib/diagnostics/logger";
import { EventEnum, FakeAudioSurface, makePlayableTrack } from "./fake-audio";

function createEngine() {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  return { surface, engine };
}

/** Flushes the async play/reject chain back out to listeners. */
async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("PlayerEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("constructs with a clean surface and no emitted events", () => {
    const { surface } = createEngine();
    expect(surface.src).toBe("");
    expect(surface.paused).toBe(true);
    expect(new PlayerEngine(surface).currentGeneration).toBe(0);
  });

  it("loads a playable track onto the persistent element", () => {
    const { surface, engine } = createEngine();
    const track = makePlayableTrack("t1");
    engine.load(track, false);
    expect(surface.src).toBe("https://audio.example/t1.mp3");
    expect(surface.loadCalls).toBe(1);
    expect(engine.currentGeneration).toBe(1);
  });

  it("plays automatically when autoplay is requested", async () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("t1"), true);
    expect(surface.play).toHaveBeenCalledTimes(1);
    await surface.play.mock.results[0].value;
  });

  it("emits unavailable when the track has no stream URL", () => {
    const { surface, engine } = createEngine();
    const events: Array<{ kind?: string; message?: string }> = [];
    engine.on("error", ({ error }) => events.push({ kind: error?.kind, message: error?.message }));
    engine.load(makePlayableTrack("t1", { streamUrl: undefined, previewUrl: undefined }), false);
    expect(surface.loadCalls).toBe(0);
    expect(events[0]).toMatchObject({ kind: "unavailable" });
    const error = events[0].message;
    expect(typeof error).toBe("string");
  });

  it("resolves play and relays the playing state from the element", async () => {
    const { surface, engine } = createEngine();
    const events: EngineEvent[] = [];
    for (const event of ["play", "playing", "pause"] as const) {
      engine.on(event, () => events.push(event));
    }
    engine.load(makePlayableTrack("t1"), false);
    await engine.play();
    expect(events).toContain("playing");
    expect(surface.paused).toBe(false);
  });

  it("relays pause from the element", async () => {
    const { surface, engine } = createEngine();
    const paused = vi.fn();
    engine.on("pause", paused);
    engine.pause();
    expect(paused).toHaveBeenCalledTimes(1);
    expect(surface.pausedCalls).toBe(1);
  });

  it("clamps seeks to [0, duration] once duration is known", () => {
    const { surface, engine } = createEngine();
    surface.duration = 100;
    engine.seek(250);
    expect(surface.currentTime).toBe(100);
    engine.seek(-5);
    expect(surface.currentTime).toBe(0);
    engine.seek(37);
    expect(surface.currentTime).toBe(37);
  });

  it("ignores invalid seek values instead of emitting NaN", () => {
    const { surface, engine } = createEngine();
    surface.duration = 100;
    engine.seek(Number.NaN);
    expect(surface.currentTime).toBe(0);
    engine.seek(Number.POSITIVE_INFINITY);
    expect(Number.isFinite(surface.currentTime)).toBe(true);
  });

  it("seeks gracefully before metadata is available", () => {
    const { surface, engine } = createEngine();
    surface.duration = 0;
    engine.seek(10);
    expect(surface.currentTime).toBe(10);
    expect(Number.isFinite(surface.currentTime)).toBe(true);
  });

  it("clamps volume into [0, 1]", () => {
    const { surface, engine } = createEngine();
    engine.setVolume(1.4);
    expect(surface.volume).toBe(1);
    engine.setVolume(-3);
    expect(surface.volume).toBe(0);
    engine.setVolume(0.5);
    expect(surface.volume).toBe(0.5);
  });

  it("toggles mute deterministically", () => {
    const { surface, engine } = createEngine();
    expect(surface.muted).toBe(false);
    engine.toggleMute();
    expect(surface.muted).toBe(true);
    engine.toggleMute();
    expect(surface.muted).toBe(false);
  });

  it("reports duration on loadedmetadata", () => {
    const { surface, engine } = createEngine();
    const duration = vi.fn();
    engine.on("loadedmetadata", ({ duration: d }) => duration(d));
    surface.duration = 214;
    surface.dispatch(EventEnum.loadedmetadata);
    expect(duration).toHaveBeenCalledWith(214);
  });

  it("throttles timeupdate to one emit per interval", () => {
    const { surface, engine } = createEngine();
    const updates: number[] = [];
    engine.on("timeupdate", ({ currentTime }) => updates.push(currentTime ?? 0));
    surface.currentTime = 1;
    surface.dispatch(EventEnum.timeupdate);
    surface.currentTime = 2;
    surface.dispatch(EventEnum.timeupdate);
    expect(updates).toEqual([1]);
    vi.advanceTimersByTime(300);
    surface.currentTime = 3;
    surface.dispatch(EventEnum.timeupdate);
    expect(updates).toEqual([1, 3]);
  });

  it("relays loading state via waiting/canplay", () => {
    const { surface, engine } = createEngine();
    const states: string[] = [];
    engine.on("waiting", () => states.push("waiting"));
    engine.on("canplay", () => states.push("canplay"));
    engine.on("playing", () => states.push("playing"));
    surface.dispatch(EventEnum.waiting);
    surface.dispatch(EventEnum.canplay);
    surface.dispatch(EventEnum.playing);
    expect(states).toEqual(["waiting", "canplay", "playing"]);
  });

  it("maps media element errors to user-safe player errors", () => {
    const { surface, engine } = createEngine();
    const errors: Array<{ kind?: string }> = [];
    engine.on("error", ({ error }) => errors.push({ kind: error?.kind }));
    surface.error = { code: 4 };
    surface.dispatch(EventEnum.error);
    surface.error = { code: 2 };
    surface.dispatch(EventEnum.error);
    expect(errors).toEqual([{ kind: "unavailable" }, { kind: "playback" }]);
  });

  it("emits ended when the element reports it", () => {
    const { surface, engine } = createEngine();
    const ended = vi.fn();
    engine.on("ended", ended);
    surface.dispatch(EventEnum.ended);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("handles rapid track switches without a stale src", () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("a"), true);
    engine.load(makePlayableTrack("b"), true);
    engine.load(makePlayableTrack("c"), true);
    expect(surface.src).toBe("https://audio.example/c.mp3");
    expect(surface.loadCalls).toBe(3);
  });

  it("converts autoplay rejection into an emitted autoplay error", async () => {
    const { surface, engine } = createEngine();
    const errors: Array<{ kind?: string }> = [];
    engine.on("error", ({ error }) => errors.push({ kind: error?.kind }));
    surface.failsWith(
      new DOMException("blocked", "NotAllowedError"),
    );
    engine.load(makePlayableTrack("t1"), true);
    await flush();
    expect(errors[0]).toMatchObject({ kind: "autoplay" });
    expect(surface.paused).toBe(true);
  });

  it("treats NotSupportedError as a playback failure, not a policy block", async () => {
    // NotSupportedError means the media resource itself is not supported
    // (a source condition) — never a missing user gesture. Surfacing it
    // as "blocked by the browser" lies to the user and hides the failure
    // from source recovery.
    const { surface, engine } = createEngine();
    const errors: Array<{ kind?: string; message?: string }> = [];
    engine.on("error", ({ error }) =>
      errors.push({ kind: error?.kind, message: error?.message }),
    );
    surface.failsWith(new DOMException("unsupported", "NotSupportedError"));
    await expect(engine.play()).rejects.toMatchObject({ kind: "playback" });
    expect(errors).toEqual([
      { kind: "playback", message: "Playback failed unexpectedly." },
    ]);
  });

  it("tolerates AbortError without surfacing an error", async () => {
    const { surface, engine } = createEngine();
    const errors: Array<{ kind?: string }> = [];
    engine.on("error", ({ error }) => errors.push({ kind: error?.kind }));
    surface.failsWith(new DOMException("aborted", "AbortError"));
    await engine.play();
    expect(errors).toEqual([]);
  });

  it("removes listeners on cleanup and stays idempotent", () => {
    const { surface, engine } = createEngine();
    const events: string[] = [];
    engine.on("ended", () => events.push("ended"));
    engine.load(makePlayableTrack("t1"), false);
    expect(surface.listenerCount).toBeGreaterThan(0);

    engine.cleanup();
    expect(surface.listenerCount).toBe(0);
    surface.dispatch(EventEnum.ended);
    expect(events).toEqual([]);
    engine.cleanup();
    expect(surface.listenerCount).toBe(0);
  });

  it("off() removes a single listener", () => {
    const { surface, engine } = createEngine();
    const listener = vi.fn();
    engine.on("ended", listener);
    engine.off("ended", listener);
    surface.dispatch(EventEnum.ended);
    expect(listener).not.toHaveBeenCalled();
  });

  it("throws PlayerError from play() so callers can react", async () => {
    const { surface, engine } = createEngine();
    surface.failsWith(new DOMException("blocked", "NotAllowedError"));
    await expect(engine.play()).rejects.toBeInstanceOf(PlayerError);
  });

  it("does not construct a media element per track (single surface)", () => {
    const { surface, engine } = createEngine();
    for (const id of ["a", "b", "c"]) {
      engine.load(makePlayableTrack(id), false);
    }
    expect(surface.loadCalls).toBe(3);
  });

  it("relays stalled events for controller stall detection", () => {
    const { surface, engine } = createEngine();
    const events: EngineEvent[] = [];
    engine.on("stalled", () => events.push("stalled"));
    surface.dispatch(EventEnum.stalled);
    expect(events).toEqual(["stalled"]);
  });

  it("carries media error codes for controller classification", () => {
    const { surface, engine } = createEngine();
    const codes: Array<number | undefined> = [];
    engine.on("error", ({ error }) => codes.push(error?.mediaCode));
    surface.error = { code: 2 };
    surface.dispatch(EventEnum.error);
    surface.error = { code: 3 };
    surface.dispatch(EventEnum.error);
    surface.error = { code: 4 };
    surface.dispatch(EventEnum.error);
    expect(codes).toEqual([2, 3, 4]);
  });

  it("suppresses aborted fetches instead of reporting failure", () => {
    const { surface, engine } = createEngine();
    const events: unknown[] = [];
    engine.on("error", (payload) => events.push(payload));
    surface.error = { code: 1 };
    surface.dispatch(EventEnum.error);
    expect(events).toEqual([]);
  });

  it("logs safe media diagnostics without URLs or secrets", () => {
    const { surface, engine } = createEngine();
    const records: LogRecord[] = [];
    const restore = setLogSink((record) => {
      records.push(record);
    });
    setLogLevel("debug");
    try {
      engine.on("error", () => undefined);
      (surface as unknown as Record<string, unknown>).networkState = 3;
      (surface as unknown as Record<string, unknown>).readyState = 0;
      surface.error = { code: 4 };
      surface.dispatch(EventEnum.error);
    } finally {
      restore();
      setLogLevel("error");
    }
    const media = records.filter(
      (record) => record.event === "playback_media_error",
    );
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      level: "warn",
      fields: { mediaCode: 4, networkState: 3, readyState: 0 },
    });
    for (const record of records) {
      const serialized = JSON.stringify(record);
      expect(serialized).not.toMatch(/https?:\/\//);
      expect(serialized).not.toMatch(/googlevideo|sig=|token|cookie/i);
    }
  });

  it("logs no media diagnostics for superseded (aborted) loads", () => {
    const { surface } = createEngine();
    const records: LogRecord[] = [];
    const restore = setLogSink((record) => {
      records.push(record);
    });
    setLogLevel("debug");
    try {
      surface.error = { code: 1 };
      surface.dispatch(EventEnum.error);
    } finally {
      restore();
      setLogLevel("error");
    }
    expect(
      records.filter((record) => record.event === "playback_media_error"),
    ).toEqual([]);
  });
});
describe("PlayerEngine same-source skip", () => {
  it("leaves a playing element untouched when the same source reloads", async () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("t1"), false);
    expect(surface.loadCalls).toBe(1);
    surface.paused = false;

    engine.load(makePlayableTrack("t1"), true);

    // No src reassignment, no load(): the audible restart is skipped, while
    // the autoplay intent still reaches the element.
    expect(surface.loadCalls).toBe(1);
    expect(surface.src).toBe("https://audio.example/t1.mp3");
    expect(surface.play).toHaveBeenCalledTimes(1);
    await surface.play.mock.results[0].value;
  });

  it("reloads the same source when paused, preserving restart semantics", () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("t1"), false);
    surface.paused = false;
    surface.pause();

    engine.load(makePlayableTrack("t1"), true);

    expect(surface.loadCalls).toBe(2);
  });

  it("reloads when the URL differs even for the same track key", () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("t1"), false);
    surface.paused = false;

    engine.load(
      makePlayableTrack("t1", { streamUrl: "https://audio.example/t1b.mp3" }),
      false,
    );

    expect(surface.loadCalls).toBe(2);
    expect(surface.src).toBe("https://audio.example/t1b.mp3");
  });
});

describe("mediaDiagnostics", () => {
  it("reports element state without ever exposing the source URL", () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("t1"), false);
    (surface as unknown as Record<string, unknown>).readyState = 3;
    (surface as unknown as Record<string, unknown>).networkState = 2;

    const state = engine.mediaDiagnostics();
    expect(state).toMatchObject({
      hasSource: true,
      readyState: 3,
      networkState: 2,
      paused: true,
      ended: false,
      errorCode: null,
    });

    // A googlevideo URL is signed and short-lived. This snapshot is exposed to
    // the E2E probe, so serializing it anywhere must not carry the URL.
    expect(JSON.stringify(state)).not.toContain("audio.example");
    expect(JSON.stringify(state)).not.toContain("https://");
    expect(Object.keys(state)).not.toContain("src");
  });

  it("reports no source before anything is loaded", () => {
    const { engine } = createEngine();
    const state = engine.mediaDiagnostics();
    expect(state.hasSource).toBe(false);
    expect(state.currentTime).toBe(0);
    expect(state.duration).toBe(0);
    expect(state.errorCode).toBeNull();
  });

  it("surfaces the media error code and coerces junk state to null", () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("t1"), false);
    (surface as unknown as Record<string, unknown>).error = { code: 3 };
    (surface as unknown as Record<string, unknown>).readyState = Number.NaN;
    expect(engine.mediaDiagnostics().errorCode).toBe(3);
    expect(engine.mediaDiagnostics().readyState).toBeNull();
  });

  it("keeps a non-finite duration at 0 rather than NaN", () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("t1"), false);
    (surface as unknown as Record<string, unknown>).duration = Number.NaN;
    expect(engine.mediaDiagnostics().duration).toBe(0);
  });

  it("reports the source scheme without reporting the source", () => {
    const { engine } = createEngine();
    engine.load(makePlayableTrack("t1"), false);
    expect(engine.mediaDiagnostics().sourceScheme).toBe("https");

    // The whole point of the field: "is this local or remote" is answerable,
    // while the URL - which for a local file is an object URL and for a provider
    // is a signed googlevideo link - is not reachable from the snapshot.
    const state = engine.mediaDiagnostics();
    expect(JSON.stringify(state)).not.toContain("audio.example");
    expect(Object.keys(state)).not.toContain("src");
  });

  it("surfaces the native error message that separates the code-4 causes", () => {
    // Every one of these is MediaError.code 4, so the code alone cannot say
    // which happened. Measured in Chromium against blob: sources:
    //   "Media load rejected by URL safety check" -> the source was blocked
    //   "Format error"                           -> empty or truncated file
    //   "DEMUXER_ERROR_COULD_NOT_OPEN"           -> undecodable container
    const cases = [
      "MEDIA_ELEMENT_ERROR: Format error",
      "MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check",
      "PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed",
    ];
    for (const message of cases) {
      const { surface, engine } = createEngine();
      engine.load(makePlayableTrack("t1"), false);
      (surface as unknown as Record<string, unknown>).error = { code: 4, message };
      expect(engine.mediaDiagnostics().errorCode).toBe(4);
      expect(engine.mediaDiagnostics().errorMessage).toBe(message);
    }
  });

  it("redacts a media error message that carries source detail", () => {
    // The browser does not fully author this string, and other engines have been
    // observed to include the offending source in it. A signed URL must not reach
    // a log or a test through this field.
    const hostile = [
      "failed to load blob:null/9f2a-https://r1.googlevideo.com/videoplayback?id=abc",
      "cannot open C:\\Users\\someone\\Music\\track.opus",
      "denied for /home/someone/Music/secret/track.opus",
      "token " + "a".repeat(48),
    ];
    for (const message of hostile) {
      const { surface, engine } = createEngine();
      engine.load(makePlayableTrack("t1"), false);
      (surface as unknown as Record<string, unknown>).error = { code: 4, message };
      const reported = engine.mediaDiagnostics().errorMessage;
      expect(reported).toMatch(/^\[redacted: /);
      expect(reported).not.toContain("googlevideo");
      expect(reported).not.toContain("someone");
    }
  });

  it("reports no error message when the element has none", () => {
    const { surface, engine } = createEngine();
    engine.load(makePlayableTrack("t1"), false);
    (surface as unknown as Record<string, unknown>).error = null;
    expect(engine.mediaDiagnostics().errorMessage).toBeNull();
    (surface as unknown as Record<string, unknown>).error = { code: 4, message: "   " };
    expect(engine.mediaDiagnostics().errorMessage).toBeNull();
  });
});

describe("safeMediaErrorMessage", () => {
  it("keeps browser boilerplate verbatim", () => {
    expect(safeMediaErrorMessage("MEDIA_ELEMENT_ERROR: Format error")).toBe(
      "MEDIA_ELEMENT_ERROR: Format error",
    );
  });

  it("bounds an over-long message rather than trusting it", () => {
    const long = `${"a ".repeat(200)}end`;
    // Long runs of words are fine, but the total is capped.
    expect((safeMediaErrorMessage(long) ?? "").length).toBeLessThanOrEqual(160);
  });

  it("rejects non-strings and blanks", () => {
    expect(safeMediaErrorMessage(undefined)).toBeNull();
    expect(safeMediaErrorMessage(null)).toBeNull();
    expect(safeMediaErrorMessage(42)).toBeNull();
    expect(safeMediaErrorMessage("")).toBeNull();
    expect(safeMediaErrorMessage("   ")).toBeNull();
  });
});

describe("sourceSchemeOf", () => {
  it("returns only the scheme", () => {
    expect(sourceSchemeOf("https://example.test/a.m4a")).toBe("https");
    expect(sourceSchemeOf("blob:null/9f2a")).toBe("blob");
    expect(sourceSchemeOf("BLOB:null/9f2a")).toBe("blob");
    expect(sourceSchemeOf("data:audio/ogg;base64,AAA")).toBe("data");
  });

  it("returns null when there is no scheme", () => {
    expect(sourceSchemeOf("")).toBeNull();
    expect(sourceSchemeOf(undefined)).toBeNull();
    expect(sourceSchemeOf("relative/path.m4a")).toBeNull();
  });
});
