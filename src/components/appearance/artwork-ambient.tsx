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
 * The custom properties this component owns on the document element.
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
] as const;

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
 *   - Writes four `--aurora-artwork-*` custom properties on the document
 *     element. NOT on the shell root, and NOT into state: the properties are
 *     read by one decorative layer, so pushing them through React would
 *     re-render the entire shell on every track change for a two-pixel
 *     gradient. Custom properties on `:root` are read by descendants without
 *     invalidating anything React knows about.
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
    const root = document.documentElement;

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
   * Removes the properties when the component goes away.
   *
   * NECESSARY, NOT TIDY. The properties are written to `document.documentElement`
   * on purpose - that is what keeps a palette swap from re-rendering the shell -
   * but it also means React never removes them, because React did not put them
   * there. Without this, turning the feature off leaves the last album's colour
   * on the document indefinitely.
   *
   * It is safe to be late about it: the ambient layer is gated on
   * `[data-aurora-artwork]`, so nothing is visible while the feature is off, and
   * a turn-off immediately followed by a turn-on would not want to pay a
   * decode for the second one. An empty dependency list, so it runs on unmount
   * only and never competes with the palette effect above.
   */
  useEffect(() => {
    return () => {
      const style = document.documentElement.style;
      for (const property of ARTWORK_PROPERTIES) {
        style.removeProperty(property);
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
