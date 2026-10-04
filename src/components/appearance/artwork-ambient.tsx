"use client";

import { useEffect } from "react";
import { useMusicEngineState } from "@/lib/music/use-music-engine";
import { resolveArtworkUrl } from "@/lib/domain";
import {
  clearPaletteCache,
  resolveArtworkPalette,
  type AuroraPalette,
} from "@/lib/appearance/artwork-palette";

/**
 * The custom properties this component owns on the shell root (see
 * `ambientTarget` above for why that element and not the document).
 *
 * Named in one place so the write and the cleanup cannot drift apart. A
 * property added to `applyPalette` and not to this list would be a colour left
 * behind with nothing left to overwrite it - invisible today, because the
 * layer is gated on the flag, and a rendering artefact the day it is not.
 */
const ARTWORK_PROPERTIES = [
  "--aurora-artwork-primary",
  "--aurora-artwork-secondary",
  "--aurora-artwork-glow",
  "--aurora-artwork-tint",
  "--aurora-artwork-strength",
  "--aurora-artwork-source-x",
  "--aurora-artwork-source-y",
  "--aurora-artwork-source-w",
  "--aurora-artwork-source-h",
] as const;

/**
 * Where the ambient properties live.
 *
 * The shell root (`[data-aurora-glass]`), NOT `document.documentElement`.
 * The artwork gradients (`--aurora-artwork-core`, `--aurora-artwork-layer`,
 * the per-edge layers) are DECLARED on that same element — they have to be,
 * because they derive from the user's `--p-appearance-aurora`, which
 * `AppearanceRoot` writes as an inline style there, and a custom property
 * substitutes its `var()` references at the element that declares it.
 * A declaration on the shell root therefore shadows anything inherited from
 * the document element: values written to `document.documentElement` never
 * reach the gradients, and the whole field silently renders transparent
 * (measured 2026-10-04: strength `1` on the document, `0` at the shell,
 * zero-size core, transparent player glow). Writing here puts the values on
 * the element the gradients resolve against, so inline style wins over the
 * stylesheet default on that same element.
 *
 * Falls back to the document element when no shell root is mounted — an
 * isolated test, or the unmount race where the shell is already gone — so a
 * missing shell is a no-op rather than a crash.
 */
function ambientTarget(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("[data-aurora-glass]") ??
    document.documentElement
  );
}

/**
 * Artwork-reactive ambience (Phase 53, §39, §40).
 *
 * Mounted only when the user has turned the feature on, so an opted-out
 * application never subscribes to the engine at all. That is a deliberate
 * mount condition rather than a check inside the effect: not subscribing is
 * strictly cheaper than subscribing and returning early, and this component
 * has no other reason to exist.
 *
 * WHAT IT DOES, and why none of it is a React concern:
 *
 *   - Subscribes to `currentTrack` through the existing module-level engine
 *     subscription, selected by identity. It re-runs only when the track
 *     actually changes.
 *   - Resolves the palette, memoised by artwork URL inside
 *     `artwork-palette.ts`, so a re-render or a queue reorder costs a map
 *     lookup rather than a decode.
 *   - Writes four `--aurora-artwork-*` custom properties on the shell root
 *     (see `ambientTarget` above). NOT into state: the properties are
 *     read by one decorative layer, so pushing them through React would
 *     re-render the entire shell on every track change for a two-pixel
 *     gradient. Inline style on the element the gradients resolve against
 *     invalidates nothing React knows about.
 *
 * WHAT IT MUST NOT DO. No layout property is written - only colours - so
 * nothing reflows, nothing is invalidated outside the compositor, and no
 * scroll position moves. Nothing under `src/lib/player`, `src/lib/music` or
 * `src/lib/playback` imports this file or `artwork-palette.ts`, and
 * `quality-gates.test.ts` asserts that, because §40's "no effect on playback
 * logic" has to be structural rather than a promise.
 *
 * The analysis itself is deferred to an idle callback. Decoding an image
 * costs a frame, and a frame spent decoding artwork during a track change is
 * a frame the audio pipeline did not get.
 */
export function ArtworkAmbient() {
  const artworkUrl = useMusicEngineState((state) => {
    const track = state.currentTrack;
    return track ? (resolveArtworkUrl(track.artwork) ?? null) : null;
  });

  useEffect(() => {
    const root = ambientTarget();

    if (!artworkUrl) {
      // Nothing playing. Leaving the last palette in place would keep a
      // departed album's colour in the room, so the strength goes to zero and
      // the layer stops contributing.
      root.style.setProperty("--aurora-artwork-strength", "0");
      return;
    }

    let cancelled = false;
    const run = () => {
      void resolveArtworkPalette(artworkUrl, {
        createImage: (src, crossOrigin) => {
          const image = new Image();
          if (crossOrigin) {
            image.crossOrigin = crossOrigin;
          }
          return image;
        },
        createCanvas: (width, height) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          return canvas;
        },
      }).then((palette) => {
        if (cancelled) {
          return;
        }
        applyPalette(root, palette);
      });
    };

    const idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(run, { timeout: 500 })
        : setTimeout(run, 0);

    return () => {
      cancelled = true;
      if (typeof cancelIdleCallback === "function" && typeof idle === "number") {
        cancelIdleCallback(idle);
      } else {
        clearTimeout(idle as ReturnType<typeof setTimeout>);
      }
    };
  }, [artworkUrl]);

  /**
   * Publishes the PLAYER'S OWN RENDERED BOUNDS as CSS custom properties.
   *
   * WHY THIS EXISTS. The ambient field used to be anchored to the middle of the
   * viewport, which reads as a page tint rather than as light coming from
   * somewhere. The concept is that the PLAYER is the emitter, so the field has to
   * know where the player actually is — and that is not knowable in CSS alone,
   * because the player's position depends on the sidebar, the mini/full player
   * mode, safe-area insets and viewport size.
   *
   * WHY IT IS NOT REACT STATE. These are six numbers that change on resize and
   * on layout changes, and they are consumed only by stylesheets. Writing them
   * from an effect would re-render this component — and therefore the shell —
   * on every resize tick, for something no component reads. So this writes
   * straight to the element inside a `requestAnimationFrame`, coalescing a burst
   * of resize events into at most one style write per frame, and React never
   * learns it happened.
   *
   * `ResizeObserver` on the player root covers the common case; the window
   * `resize` listener covers the rest (viewport resize, sidebar collapse,
   * safe-area changes), and both funnel into the same rAF-throttled writer.
   *
   * NO `scroll` LISTENER, DELIBERATELY. Every surface carrying
   * `data-aurora-player` — bar, mini and full — is `position: fixed`, so its
   * viewport rect is mathematically invariant under document scrolling. A
   * listener here would run on every frame of every scroll to recompute a number
   * that cannot have changed. A static gate holds the allowance at zero, and
   * that is the correct allowance rather than an inconvenient one: if a future
   * player surface is ever laid out in flow, that gate failing is the signal to
   * add the listener then, with the reason written down.
   */
  useEffect(() => {
    const root = ambientTarget();
    const PLAYER_SELECTOR = "[data-aurora-player]";

    let frame = 0;
    const publish = () => {
      frame = 0;
      // The VISIBLE player, and the LARGEST one when several are mounted.
      //
      // `querySelector` returns the first match, and on desktop that is the MINI
      // player, which is `lg:hidden` — a zero-sized rect that parked the whole
      // field and made Ambient Light render nothing at all. All three surfaces
      // are always in the tree; which one is on screen is a styling decision,
      // so the emitter has to be chosen by what is actually rendered, not by
      // document order. Largest area wins, which is also the right precedence:
      // the full-screen takeover supersedes the bar, which supersedes the mini.
      let player: HTMLElement | null = null;
      let bestArea = 0;
      for (const candidate of document.querySelectorAll<HTMLElement>(PLAYER_SELECTOR)) {
        const rect = candidate.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          player = candidate;
        }
      }
      if (!player) {
        // No player rendered (nothing playing yet): park the field off-screen
        // so the ambient contributes nothing rather than defaulting to the
        // viewport centre, which is the "random page gradient" look.
        for (const property of [
          "--aurora-artwork-source-x",
          "--aurora-artwork-source-y",
          "--aurora-artwork-source-w",
          "--aurora-artwork-source-h",
        ]) {
          root.style.setProperty(property, "0px");
        }
        return;
      }
      const rect = player.getBoundingClientRect();
      // `Math.round` keeps the written value stable while a drag settles, so a
      // resize that moves the player by a sub-pixel amount does not churn the
      // style attribute.
      root.style.setProperty("--aurora-artwork-source-x", `${Math.round(rect.left)}px`);
      root.style.setProperty("--aurora-artwork-source-y", `${Math.round(rect.top)}px`);
      root.style.setProperty("--aurora-artwork-source-w", `${Math.round(rect.width)}px`);
      root.style.setProperty("--aurora-artwork-source-h", `${Math.round(rect.height)}px`);
    };

    const schedule = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(publish);
    };

    publish();

    const players = () =>
      Array.from(document.querySelectorAll<HTMLElement>(PLAYER_SELECTOR));
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      for (const player of players()) observer.observe(player);
    }
    window.addEventListener("resize", schedule);

    // The player set is not fixed: the full player only mounts when opened, and
    // the bar swaps in and out with playback state. A MutationObserver on the
    // shell keeps the observed set current without polling.
    const mutations = new MutationObserver(() => {
      if (observer) {
        observer.disconnect();
        for (const player of players()) observer.observe(player);
      }
      schedule();
    });
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, []);

  /**
   * Removes the properties when the component goes away.
   *
   * NECESSARY, NOT TIDY. The properties are written to the shell root on
   * purpose - that is what keeps a palette swap from re-rendering the shell -
   * but it also means React never removes them, because React did not put them
   * there. Without this, turning the feature off leaves the last album's colour
   * on the shell indefinitely.
   *
   * Captured, not re-queried: at unmount time the shell may already be gone
   * (React removes children before parents' cleanups when the whole tree goes),
   * and a fresh `ambientTarget()` call then falls back to the document element
   * — cleaning the wrong element and leaving the colours behind. The effect
   * closes over the element it wrote to.
   *
   * It is safe to be late about it: the ambient layer is gated on
   * `[data-aurora-artwork]`, so nothing is visible while the feature is off, and
   * a turn-off immediately followed by a turn-on would not want to pay a
   * decode for the second one. An empty dependency list, so it runs on unmount
   * only and never competes with the palette effect above.
   */
  useEffect(() => {
    const target = ambientTarget();
    return () => {
      for (const property of ARTWORK_PROPERTIES) {
        target.style.removeProperty(property);
      }
    };
  }, []);

  return null;
}

function applyPalette(
  root: HTMLElement,
  palette: AuroraPalette,
): void {
  root.style.setProperty("--aurora-artwork-primary", palette.primary);
  root.style.setProperty("--aurora-artwork-secondary", palette.secondary);
  root.style.setProperty("--aurora-artwork-glow", palette.glow);
  root.style.setProperty("--aurora-artwork-tint", palette.tint);
  root.style.setProperty("--aurora-artwork-strength", "1");
}

/**
 * Exported for the test that proves the cache is bounded; not part of the
 * component's behaviour.
 */
export { clearPaletteCache };
