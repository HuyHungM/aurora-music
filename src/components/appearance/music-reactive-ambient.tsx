"use client";

import { useEffect } from "react";
import { useAppearance } from "@/components/appearance/appearance-root";
import {
  MUSIC_FFT_SIZE,
  MUSIC_REACTIVE_GAIN,
  SILENT_ENERGY,
  createBeatDetector,
  createSmoother,
  readBands,
  type MusicEnergy,
} from "@/lib/appearance/music-reactive";
import { getDefaultEngine } from "@/lib/player/engine-factory";
import { useMusicEngine } from "@/lib/music/use-music-engine";

/**
 * Music-reactive Ambient Light: the ONE place audio becomes visual.
 *
 * ARCHITECTURE, and why it is shaped this way.
 *
 *   Artwork  ──> artwork-palette.ts ──┐
 *                                      ├──> CSS custom properties ──> CSS renders
 *   Audio    ──> THIS FILE ───────────┘
 *
 * The palette and the audio are computed independently and combined only in
 * CSS. Audio can therefore change how the light MOVES and how strongly it
 * burns, but it can never change its colour: no frequency value is allowed
 * anywhere near a hue.
 *
 * NOTHING PER FRAME TOUCHES REACT. This component subscribes once to "is
 * playing" and once to the user's setting, then hands the animation to a
 * `requestAnimationFrame` loop that writes custom properties imperatively. A
 * `setState` per frame would re-render the shell at 60 Hz for a gradient; that
 * is the single most expensive mistake available here and it is avoided
 * structurally rather than by discipline.
 *
 * THE LOOP ONLY EXISTS WHEN IT CAN DO SOMETHING. It runs while Ambient Light is
 * on, music reactivity is not `off`, audio is actually playing, and the document
 * is visible. Paused, hidden, or off, there is no rAF, no analyser read and no
 * style write at all — the features are separable so that "off" costs nothing
 * rather than costing a running loop that writes zeroes.
 *
 * PLAYBACK SAFETY. The analyser is fed by `captureStream()`, a parallel tap of
 * the element's OUTPUT, never by `createMediaElementSource`, which would route
 * audio through Web Audio and mute the element outright when the provider
 * withholds CORS. If `captureStream` is missing or throws — Safari, or any
 * element without a source — the whole feature stands down and the artwork
 * ambient carries on untouched. Music reactivity can cost the effect; it cannot
 * cost playback.
 */

/** Written every frame while the loop runs. All are 0..1. */
const MUSIC_PROPERTIES = [
  "--aurora-music-bass",
  "--aurora-music-mid",
  "--aurora-music-treble",
  "--aurora-music-energy",
  "--aurora-music-beat",
] as const;

/** Format once at module scope: this runs per frame. */
const fmt = (value: number) => value.toFixed(3);

/**
 * Where the music values are published.
 *
 * The shell root (`[data-aurora-glass]`), for the same reason as the palette in
 * `artwork-ambient.tsx`: the consumers (`--aurora-ambient-reach` aside, every
 * rule reads through gradients declared on that element) resolve at the
 * declaration site, so values written to `document.documentElement` are shadowed
 * by the defaults and the reactivity silently reads as zero. Same fallback —
 * the document element when no shell root is mounted.
 */
function musicTarget(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("[data-aurora-glass]") ??
    document.documentElement
  );
}

export function MusicReactiveAmbient() {
  const { appearance } = useAppearance();
  // Only WHETHER an engine exists, and that reference is referentially stable
  // for the engine's lifetime — so this re-renders once when `PlayerHost`
  // mounts, never on a state change. Reading `isPlaying` through a hook instead
  // would re-render on every play and pause; reading it through `getMusicEngine()`
  // inside the effect would capture `null` when the host has not mounted yet and
  // subscribe to nothing, permanently. This is the one value React has to own.
  const engine = useMusicEngine();

  const reactivity = appearance.ambientMusicReactive;
  const enabled = appearance.artworkAmbient;

  useEffect(() => {
    const root = musicTarget();

    // Nothing to do: publish zeros so any CSS still referencing these variables
    // resolves, then leave. No loop, no analyser, no listener.
    if (!enabled || reactivity === "off") {
      for (const property of MUSIC_PROPERTIES) root.style.setProperty(property, "0");
      return;
    }

    // PAUSED IS NOT A TEARDOWN. Playback state is read from a local variable fed
    // by an imperative engine subscription, NOT from a hook value in the
    // dependency list — and that distinction is load-bearing.
    //
    // With `isPlaying` in the deps, a track change (which flips it) tore down
    // and rebuilt the whole audio graph: a fresh AudioContext created and
    // closed, the tap stopped, on every transition. Measured consequence: the
    // reaction died on the second track and never came back, because the rebuilt
    // analyser was reading a stream whose track had already been stopped.
    // Subscribing once and branching inside the loop builds the graph once per
    // mount, and it survives every pause, resume and track change.
    //
    // `arm` exists so the callback never touches a binding declared below it:
    // the subscription is made before `tick` exists, and a synchronous notify
    // would otherwise be a temporal-dead-zone crash rather than a subtle bug.
    let playing = false;
    let arm: (() => void) | null = null;
    const unsubscribe = engine
      ? engine.subscribe(() => {
          playing = engine.getState().isPlaying;
          arm?.();
        })
      : () => undefined;
    playing = engine?.getState().isPlaying ?? false;

    const gain = MUSIC_REACTIVE_GAIN[reactivity];

    // Reduced motion keeps the static artwork illumination and drops only the
    // movement, so the feature degrades to what it was before this file existed
    // rather than to nothing.
    const motionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const motionScale = motionQuery?.matches ? 0 : 1;

    let context: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    // `Uint8Array<ArrayBuffer>` rather than bare `Uint8Array`: the DOM signature
    // of `getByteFrequencyData` pins the buffer kind, and the explicit
    // `new ArrayBuffer(...)` below is what satisfies it.
    let bins: Uint8Array<ArrayBuffer> | null = null;
    let stream: MediaStream | null = null;
    const smoother = createSmoother();
    const beatDetector = createBeatDetector();
    let frame = 0;
    let last = 0;
    /**
     * True only when the browser cannot do this at all (no `AudioContext`).
     * Everything else — an element with no audio tracks yet, a capture that
     * throws mid-transition — is TRANSIENT and retried on a later tick while
     * playing. Latching the first empty capture as permanent silenced whole
     * sessions: a just-loaded element yields zero tracks for its first
     * frames, so the first attempt legitimately finds nothing.
     */
    let unsupported = false;
    /**
     * Identity of the track the current tap belongs to. The tap is bound to
     * one capture: after a src swap the old one reads silence while the loop
     * keeps publishing it, so a new track, a committed load, or a restart
     * drops the source and lets the next tick rebuild it — on the SAME
     * context and analyser, never a second graph.
     */
    let tapKey: string | null = null;
    let wasPlaying = playing;
    let wasLoading = engine?.getState().isResolving ?? false;

    const tapKeyOf = (): string | null => {
      const primary = engine?.getState().currentTrack?.primarySource ?? null;
      return primary ? `${primary.source}:${primary.id}` : null;
    };

    /** Drops the source and its stream; the context, analyser and bins stay. */
    const teardownTap = () => {
      try {
        sourceNode?.disconnect();
      } catch {
        /* already gone */
      }
      sourceNode = null;
      if (stream) {
        for (const track of stream.getAudioTracks()) {
          try {
            track.stop();
          } catch {
            /* best-effort cleanup */
          }
        }
      }
      stream = null;
    };

    /** Lazily built, and only if this browser can do it at all. */
    const ensureAnalyser = (): AnalyserNode | null => {
      if (analyser && sourceNode) return analyser;
      if (unsupported) return null;
      const engine = getDefaultEngine();
      const captured = engine?.analysisStream?.() ?? null;
      // A just-loaded element yields zero audio tracks for its first frames,
      // and a provider stream throws mid-transition: both read as "nothing
      // to tap right now", not "never". The tick retries while playing.
      // A torn-down tap (track change, restart) rebuilds only its source, on
      // the SAME context and analyser — never a second graph.
      if (!captured) {
        return null;
      }
      try {
        let ctx = context;
        if (!analyser || !ctx) {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (!Ctor) {
            unsupported = true;
            return null;
          }
          ctx = new Ctor();
          context = ctx;
          // iOS starts contexts suspended; playback may have unlocked it already.
          if (ctx.state === "suspended") void ctx.resume().catch(() => {});
          const node = ctx.createAnalyser();
          node.fftSize = MUSIC_FFT_SIZE;
          // Light touch only: this smooths per-bin jitter before we band it,
          // and keeps a hard floor so the field never fully collapses in a
          // quiet bar.
          node.smoothingTimeConstant = 0.72;
          node.minDecibels = -85;
          analyser = node;
          // `frequencyBinCount` is a length, so the buffer is allocated once
          // and reused every frame — no per-frame allocation.
          bins = new Uint8Array(new ArrayBuffer(node.frequencyBinCount));
        }
        const source = ctx.createMediaStreamSource(captured);
        source.connect(analyser);
        // NOT connected to the destination: this graph exists only to observe.
        // Routing it onward would be a second output path for the same audio.
        sourceNode = source;
        stream = captured;
        return analyser;
      } catch {
        return null;
      }
    };

    const publish = (values: MusicEnergy, beat: number) => {
      // The user's setting scales the AUDIO contribution here, at the single
      // point where numbers become styles. Nothing else multiplies it, so
      // `subtle` is 45% of full response everywhere at once, and `off` is a
      // multiplier of zero rather than a second code path that renders
      // something different.
      const k = motionScale === 0 ? 0 : gain;
      root.style.setProperty("--aurora-music-bass", fmt(values.bass * k));
      root.style.setProperty("--aurora-music-mid", fmt(values.mid * k));
      root.style.setProperty("--aurora-music-treble", fmt(values.treble * k));
      root.style.setProperty("--aurora-music-energy", fmt(values.energy * k));
      root.style.setProperty("--aurora-music-beat", fmt(beat * k));
    };

    /** One frame of loop bookkeeping. `frame === 0` means "not running". */
    const stop = () => {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      last = 0;
    };

    const start = () => {
      if (frame === 0) frame = requestAnimationFrame(tick);
    };

    const tick = (now: number) => {
      const dt = last === 0 ? 16.7 : now - last;
      last = now;

      // Paused: publish the baseline once, then stop asking. The artwork light
      // is a different layer and is entirely unaffected, so the surface stays
      // lit while the music is still. Resuming needs no new effect run — the
      // subscription below re-arms the loop.
      //
      // BOTH smoothers are reset here. Without it, pausing mid-gesture leaves a
      // half-spent envelope and a lit beat impulse in the detector, and the
      // first frame after resume publishes that stale state — which is the
      // brightness spike on resume this is here to prevent.
      if (!playing) {
        smoother.reset();
        beatDetector.reset();
        publish(SILENT_ENERGY, 0);
        frame = 0;
        return;
      }

      frame = requestAnimationFrame(tick);

      const node = ensureAnalyser();
      if (!node || !bins) {
        // No analysis available (yet): hold a quiet baseline so the ambient
        // still illuminates, and keep asking on later ticks while playing.
        // Stopping here is what used to silence whole sessions.
        publish(SILENT_ENERGY, 0);
        return;
      }

      node.getByteFrequencyData(bins);
      const raw = readBands(bins);
      const eased = smoother.step(raw, dt);
      publish(eased, beatDetector.step(raw.bass, dt));
    };

    // Playback state drives the loop from OUTSIDE React, so pause and resume
    // cost one cancelled or restarted frame handle instead of a graph rebuild.
    // A new track, a committed load, or a restart additionally drops the tap:
    // the capture belongs to one element state, and the next tick rebuilds it
    // on the same graph. Resets ride along for the same reason as the pause
    // path below — a new track must not inherit the previous track's impulse.
    arm = () => {
      const state = engine?.getState() ?? null;
      const key = tapKeyOf();
      const loading = state?.isResolving ?? false;
      if (playing) {
        if (key !== tapKey || (!loading && wasLoading) || !wasPlaying) {
          teardownTap();
          smoother.reset();
          beatDetector.reset();
        }
        tapKey = key;
        start();
      } else {
        stop();
        publish(SILENT_ENERGY, 0);
      }
      wasPlaying = playing;
      wasLoading = loading;
    };
    if (playing) start();

    const onVisibility = () => {
      if (document.visibilityState === "hidden" || !playing) {
        stop();
        return;
      }
      start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const property of MUSIC_PROPERTIES) root.style.removeProperty(property);
      // Disconnect before closing so the tap is released promptly.
      teardownTap();
      try {
        analyser?.disconnect();
      } catch {
        /* the context may already be gone */
      }
      void context?.close().catch(() => {});
      context = null;
      analyser = null;
      bins = null;
    };
  }, [enabled, reactivity, engine]);

  return null;
}
