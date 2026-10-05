// @vitest-environment jsdom
/**
 * `MusicReactiveAmbient` — the component that turns audio into CSS.
 *
 * The pure analysis layer is covered in `music-reactive-beat.test.ts`. This
 * covers the half that only exists here, and it is the half that decides whether
 * the effect is SUBTLE or STROBING in practice:
 *
 *   - the loop only exists while it can do something (§15: "off" must cost
 *     nothing, not a running rAF writing zeroes forever)
 *   - pause returns to a baseline rather than freezing a high-energy frame
 *     (§18 — the freeze is what causes the spike on resume)
 *   - `prefers-reduced-motion` zeroes the published values even while music
 *     plays, so the ambience survives but the movement does not (§14)
 *   - every published value is bounded, so audio cannot reach full brightness
 *     (§12)
 *
 * The audio graph is a test double. The component's contract is that it builds
 * ONE context and ONE analyser and tears both down; asserting that needs a
 * counter, not a real AudioContext.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MusicReactiveAmbient } from "@/components/appearance/music-reactive-ambient";
import { DEFAULT_APPEARANCE, type Appearance } from "@/lib/appearance/appearance";

/* ------------------------------------------------------------------ doubles */

const created = { contexts: 0, analysers: 0, sources: 0, closed: 0 };

/** Bin values the fake analyser hands back, driven per test. */
let spectrum = new Uint8Array(256).fill(0);

class FakeAnalyser {
  frequencyBinCount = 256;
  fftSize = 512;
  smoothingTimeConstant = 0;
  minDecibels = -100;
  maxDecibels = -30;
  disconnect = vi.fn();
  getByteFrequencyData(target: Uint8Array) {
    target.set(spectrum.subarray(0, Math.min(target.length, spectrum.length)));
  }
}

class FakeAudioContext {
  state = "running";
  constructor() {
    created.contexts += 1;
  }
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    created.closed += 1;
  });
  createMediaStreamSource = vi.fn(() => {
    created.sources += 1;
    return { connect: vi.fn(), disconnect: vi.fn() };
  });
  createAnalyser() {
    created.analysers += 1;
    return new FakeAnalyser();
  }
}

/** Engine stand-in: an element that reports it is playing and yields a stream. */
function makeEngine(isPlaying: boolean) {
  const state = {
    isPlaying,
    currentTrack: null as null | {
      primarySource: { source: string; id: string };
    },
  };
  const listeners = new Set<() => void>();
  return {
    state,
    getState: () => state,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    /** Test-only: flip playback the way the real engine's subscription does. */
    setPlaying(next: boolean) {
      state.isPlaying = next;
      for (const cb of listeners) cb();
    },
    /** Test-only: switch the track identity the way a store advance does. */
    setTrack(id: string | null) {
      state.currentTrack =
        id === null ? null : { primarySource: { source: "local", id } };
      for (const cb of listeners) cb();
    },
    analysisStream: () =>
      ({
        getAudioTracks: () => [{}],
        getTracks: () => [],
      }) as unknown as MediaStream,
  };
}

let engine: ReturnType<typeof makeEngine>;
let appearance: Appearance;

/* --------------------------------------------------------------------- mocks */

vi.mock("@/components/appearance/appearance-root", () => ({
  useAppearance: () => ({ appearance }),
}));

vi.mock("@/lib/music/use-music-engine", () => ({
  useMusicEngine: () => engine,
}));

vi.mock("@/lib/player/engine-factory", () => ({
  getDefaultEngine: () => engine,
}));

/* ------------------------------------------------------------------ lifecycle */

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

/**
 * A deterministic frame queue.
 *
 * It QUEUES rather than calling back inline. The loop re-arms itself from inside
 * its own callback, so a double that invoked synchronously would recurse until
 * the stack blew — which is exactly what happened before this was a queue.
 */
const pending: FrameRequestCallback[] = [];
let clock = 0;

function pump(): void {
  const next = pending.shift();
  if (next) {
    clock += 16.7;
    next(clock);
  }
}

const MUSIC_PROPERTIES = [
  "--aurora-music-bass",
  "--aurora-music-mid",
  "--aurora-music-treble",
  "--aurora-music-energy",
  "--aurora-music-beat",
];

/** The shell root the component publishes onto. */
function shell(): HTMLElement {
  const root = document.querySelector<HTMLElement>("[data-aurora-glass]");
  if (!root) throw new Error("no shell root");
  return root;
}

const published = (property: string): number =>
  Number(shell().style.getPropertyValue(property) || "0");

/**
 * A loud, beatty spectrum: bass bins hot, treble much lower, so every band has
 * something to report and the beat detector has a transient to find.
 */
function loudSpectrum(): void {
  spectrum = new Uint8Array(256);
  spectrum.fill(40, 0, 31); // bass
  spectrum.fill(120, 0, 31); // bass, loud
  spectrum.fill(90, 32, 140); // mid
  spectrum.fill(30, 141, 255); // treble, deliberately quiet
}

beforeEach(() => {
  created.contexts = 0;
  created.analysers = 0;
  created.sources = 0;
  created.closed = 0;
  spectrum = new Uint8Array(256);
  appearance = { ...DEFAULT_APPEARANCE, artworkAmbient: true };
  engine = makeEngine(true);
  setReducedMotion(false);

  // A deterministic clock: the loop's dt must not depend on real timing.
  pending.length = 0;
  clock = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    pending.push(cb);
    return pending.length;
  }) as unknown as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => {
    pending[handle - 1] = () => undefined;
  }) as unknown as typeof globalThis.cancelAnimationFrame;
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;

  const root = document.createElement("div");
  root.setAttribute("data-aurora-glass", "on");
  document.body.appendChild(root);
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("MusicReactiveAmbient / the loop only runs when it can do something", () => {
  it("publishes zeros and builds no audio graph when reactivity is off", () => {
    appearance = { ...appearance, ambientMusicReactive: "off" };
    render(<MusicReactiveAmbient />);
    expect(created.contexts).toBe(0);
    expect(created.analysers).toBe(0);
    // Every property still resolves, so no CSS rule reads an undefined var.
    for (const property of MUSIC_PROPERTIES) {
      expect(published(property)).toBe(0);
    }
  });

  it("builds exactly one context and one analyser however many frames run", () => {
    // §15: reuse one AudioContext, one AnalyserNode. A second of animation must
    // not open a second graph.
    loudSpectrum();
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 30; i += 1) pump();
    expect(created.contexts).toBe(1);
    expect(created.analysers).toBe(1);
  });

  it("tears the graph down on unmount", () => {
    loudSpectrum();
    const { unmount } = render(<MusicReactiveAmbient />);
    pump();
    expect(created.contexts).toBe(1);
    unmount();
    expect(created.closed).toBe(1);
  });

  it("stands down without an analysis stream, leaving the artwork layer alone", () => {
    // §19: a browser without `captureStream` must cost the effect and nothing
    // else. Playback must not depend on this.
    // A browser without `captureStream` answers with null, not an empty stream.
    engine.analysisStream = () => null as unknown as MediaStream;
    render(<MusicReactiveAmbient />);
    pump();
    pump();
    expect(published("--aurora-music-bass")).toBe(0);
  });
});

describe("MusicReactiveAmbient / bounded output", () => {
  it("never publishes a value outside 0..1, even for a full-scale spectrum", () => {
    // §12: the response must stay subtle. A full-scale input is the worst case,
    // and no channel may reach 1.
    loudSpectrum();
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 60; i += 1) pump();
    for (const property of MUSIC_PROPERTIES) {
      const value = published(property);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("scales the whole response by the user's setting", () => {
    // `subtle` is 45% of full response everywhere at once, applied at the single
    // point where numbers become styles.
    loudSpectrum();
    appearance = { ...appearance, ambientMusicReactive: "subtle" };
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 60; i += 1) pump();
    const subtleBass = published("--aurora-music-bass");

    cleanup();
    document.body.innerHTML = "";
    const root = document.createElement("div");
    root.setAttribute("data-aurora-glass", "on");
    document.body.appendChild(root);
    engine = makeEngine(true);
    appearance = { ...DEFAULT_APPEARANCE, artworkAmbient: true, ambientMusicReactive: "full" };
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 60; i += 1) pump();
    const fullBass = published("--aurora-music-bass");

    expect(subtleBass).toBeGreaterThan(0);
    expect(fullBass).toBeGreaterThan(subtleBass);
  });
});

describe("MusicReactiveAmbient / pause and resume", () => {
  it("returns to a baseline on pause instead of freezing a high-energy frame", () => {
    // §18. The failure this guards is the visual freeze at whatever the last
    // loud frame happened to be, which then reads as a spike on resume.
    loudSpectrum();
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 40; i += 1) pump();
    expect(published("--aurora-music-bass")).toBeGreaterThan(0);

    engine.setPlaying(false);
    for (const property of MUSIC_PROPERTIES) {
      expect(published(property)).toBe(0);
    }
  });

  it("does not spike on the first frame after resume", () => {
    loudSpectrum();
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 40; i += 1) pump();
    engine.setPlaying(false);
    engine.setPlaying(true);
    // One frame only: the envelope restarts from the baseline, so this must be
    // far below the settled value rather than jumping straight back to it.
    pump();
    const firstFrame = published("--aurora-music-bass");
    for (let i = 0; i < 40; i += 1) pump();
    expect(published("--aurora-music-bass")).toBeGreaterThan(firstFrame);
  });

  it("keeps publishing zeros while paused, so it cannot drift", () => {
    loudSpectrum();
    render(<MusicReactiveAmbient />);
    engine.setPlaying(false);
    for (let i = 0; i < 20; i += 1) pump();
    for (const property of MUSIC_PROPERTIES) {
      expect(published(property)).toBe(0);
    }
  });
});

describe("MusicReactiveAmbient / reduced motion", () => {
  it("zeroes the reactive response while leaving the graph alone", () => {
    // §14: the artwork illumination is a different layer and must survive. So
    // the analyser is still built — only the published values are suppressed.
    setReducedMotion(true);
    loudSpectrum();
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 40; i += 1) pump();
    for (const property of MUSIC_PROPERTIES) {
      expect(published(property)).toBe(0);
    }
    expect(created.analysers).toBe(1);
  });

  it("publishes a non-zero response when motion is allowed", () => {
    // The control for the test above: same spectrum, same settings, motion on.
    setReducedMotion(false);
    loudSpectrum();
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 40; i += 1) pump();
    expect(published("--aurora-music-bass")).toBeGreaterThan(0);
  });
});

describe("MusicReactiveAmbient / tap lifecycle", () => {
  it("retries a trackless first capture instead of standing down forever", () => {
    // A just-loaded element yields zero audio tracks for its first frames, so
    // the first capture attempt legitimately finds nothing. Latching that as
    // a permanent failure silences the session; retrying while playing heals.
    loudSpectrum();
    engine.analysisStream = () => null as unknown as MediaStream;
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 3; i += 1) pump();
    expect(created.analysers).toBe(0);

    engine.analysisStream = () =>
      ({
        getAudioTracks: () => [{}],
        getTracks: () => [],
      }) as unknown as MediaStream;
    for (let i = 0; i < 40; i += 1) pump();
    expect(created.analysers).toBe(1);
    expect(published("--aurora-music-bass")).toBeGreaterThan(0);
  });

  it("rebuilds the tap when the track changes, keeping one graph", () => {
    // The tap is bound to one capture: after a src swap the old one reads
    // silence while the loop keeps publishing it. A new identity rebuilds the
    // source on the SAME context and analyser.
    loudSpectrum();
    engine.setTrack("a");
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 40; i += 1) pump();
    expect(published("--aurora-music-bass")).toBeGreaterThan(0);
    expect(created.contexts).toBe(1);

    engine.setTrack("b");
    for (let i = 0; i < 40; i += 1) pump();
    expect(published("--aurora-music-bass")).toBeGreaterThan(0);
    expect(created.contexts).toBe(1);
    expect(created.analysers).toBe(1);
    // A second source on the same graph: the tap follows the track.
    expect(created.sources).toBe(2);
  });

  it("rebuilds the tap on resume, so a stale pause cannot stick", () => {
    // Pause tears the loop down; resume must not resurrect the previous tap
    // blindly. One more source on the same graph, never a second graph.
    loudSpectrum();
    engine.setTrack("a");
    render(<MusicReactiveAmbient />);
    for (let i = 0; i < 40; i += 1) pump();
    expect(created.contexts).toBe(1);

    engine.setPlaying(false);
    engine.setPlaying(true);
    for (let i = 0; i < 40; i += 1) pump();
    expect(published("--aurora-music-bass")).toBeGreaterThan(0);
    expect(created.contexts).toBe(1);
    expect(created.analysers).toBe(1);
    expect(created.sources).toBe(2);
  });
});
