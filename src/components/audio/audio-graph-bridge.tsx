"use client";

import { useEffect } from "react";
import { setEqElementResolver } from "@/lib/audio/eq-graph";
import { getDefaultEngine } from "@/lib/player/engine-factory";

/**
 * Tells the equalizer which audio element is the application's (Phase 53
 * addendum).
 *
 * THE PROBLEM THIS SOLVES, precisely. `MediaElementAudioSourceNode` needs an
 * actual `HTMLAudioElement`, and Aurora's element lives inside `PlayerEngine`
 * as a private `AudioSurface`. So something has to hand it over, and every
 * candidate is worse than a registration:
 *
 *   - The graph could import `getDefaultEngine` and call it. Then the graph's
 *     lifetime would be the engine's lifetime, and - worse - merely importing
 *     the module would make `new Audio()` reachable from a module that has no
 *     business creating audio.
 *   - The store could carry the element. Then EQ state would hold a reference to
 *     playback, which is the coupling addendum §31 and §32 forbid.
 *   - The panel could pass it in on every change. Then the equalizer would work
 *     only while the settings page was open.
 *
 * A resolver keeps the dependency pointing one way. The EQ asks for the element;
 * the engine knows nothing about the EQ; and until something registers, the
 * answer is `null` and the equalizer is simply unavailable - which is exactly
 * the state during server rendering and in tests, and a state that needs no
 * special handling because it is the same shape as "this browser has no Web
 * Audio".
 *
 * IT REGISTERS, IT NEVER CREATES. `getDefaultEngine()` returns the existing
 * singleton or makes it; this component does not make an element of its own, and
 * neither does anything else in the EQ feature. One element, one context, one
 * playback authority.
 *
 * A `useEffect` rather than a module side effect, because a module-level
 * registration would run on the server too, where there is no element and where
 * module state is shared between requests.
 */
export function AudioGraphBridge(): null {
  useEffect(() => {
    setEqElementResolver(() => {
      if (typeof window === "undefined") {
        return null;
      }
      // `mediaElement` is null when the engine's surface is a test double
      // rather than a real element, which is a supported answer: the graph
      // declines and playback continues untouched.
      return getDefaultEngine()?.mediaElement ?? null;
    });
    return () => setEqElementResolver(() => null);
  }, []);

  return null;
}
