"use client";

import { useEffect } from "react";
import { useAppearance } from "@/components/appearance/appearance-root";
import {
  LOCAL_AMBIENT_KEYS,
  localAmbientOverride,
} from "@/lib/appearance/local-ambient";
import {
  APPEARANCE_TOKENS,
  appearanceTokenValue,
} from "@/lib/appearance/apply";
import { useMusicEngine } from "@/lib/music/use-music-engine";

/**
 * Applies the Local Music Aurora scene while a local file is playing.
 *
 * HOW IT APPLIES, and why it is written this way.
 *
 * The ambient values already reach the page as INLINE custom properties on the
 * shell root, written server-side by `appearance-root.tsx`. So the override does
 * the same thing to the same properties — and the restore is therefore exact:
 * the previous inline value is read back off the element and put straight back,
 * rather than recomputed. A recomputed restore would be a second source of
 * truth for the user's ambient settings, and would drift the moment a default
 * changed.
 *
 * NOTHING IS WRITTEN TO THE APPEARANCE STORE. This component reads
 * `appearance`, derives an override, and touches `element.style`. There is no
 * `update()`, no action, no cookie write anywhere in this file, which is the
 * whole of the "do not overwrite the user's settings" requirement — it is
 * structural, not a rule someone has to remember.
 *
 * THE TRANSITION IS CSS's, not ours. Writing the new value and letting the
 * ambient layer's own transition carry it from wherever it was is what makes
 * entering and leaving the scene continuous. Tweening the values in JS would mean
 * a second clock and a second place for the transition to be tuned.
 *
 * TRANSITION BOUNDARY, and the one real hazard here. This effect is keyed on
 * the playback source. Changing a slider re-renders and re-runs the effect, so
 * the cleanup restores the saved values and the next run writes the new ones —
 * a visible flash on every slider drag. So the effect depends ONLY on the
 * source and the preference, and reads `appearance` from a ref. Ambient changes
 * made by the user while local music plays are therefore not re-overridden until
 * the source changes, which is the correct precedence: the scene owns the
 * ambient layer while it is active, exactly as it would if the user had chosen
 * those values.
 */
export function LocalMusicAmbient() {
  const { appearance } = useAppearance();
  const engine = useMusicEngine();

  // The current track's SOURCE. `TrackIdentity` carries it on the primary
  // reference rather than as a `provider` field, so this reads the same
  // canonical source id every other layer uses. Read through the engine's
  // subscription rather than a hook so a track change does not re-render the
  // tree; `source` is the ONLY thing the effect may depend on.
  const source =
    engine?.getState().currentTrack?.primarySource?.source ?? null;

  useEffect(() => {
    // No engine, or nothing playing: nothing to override.
    if (!engine) {
      return;
    }
    const root = document.querySelector<HTMLElement>("[data-aurora-glass]");
    if (!root) {
      return;
    }

    const latest = { appearance };
    const readSource = () =>
      engine.getState().currentTrack?.primarySource?.source ?? null;

    let currentSource: string | null = null;
    let applied: Array<[string, string]> = [];

    const apply = (nextSource: string | null) => {
      const override = localAmbientOverride({
        appearance: latest.appearance,
        source: nextSource,
        preference: latest.appearance.localAmbient,
      });

      if (applied.length === 0 && Object.keys(override).length === 0) {
        return;
      }

      // Restore first, unconditionally. Doing it in one place means the
      // local -> online and online -> local paths cannot differ, and a partially
      // applied override is never observable even for a frame.
      for (const [property, value] of applied) {
        if (value === "") {
          root.style.removeProperty(property);
        } else {
          root.style.setProperty(property, value);
        }
      }
      applied = [];

      for (const key of LOCAL_AMBIENT_KEYS) {
        if (!(key in override)) {
          continue;
        }
        const property = APPEARANCE_TOKENS[key];
        const saved = root.style.getPropertyValue(property);
        applied.push([property, saved]);
        const value = override[key];
        root.style.setProperty(
          property,
          appearanceTokenValue(
            // `appearanceTokenValue` reads a full Appearance; only the field
            // being written matters, and the override supplies it.
            { ...latest.appearance, [key]: value } as typeof latest.appearance,
            key,
          ),
        );
      }
    };

    const unsubscribe = engine.subscribe(() => {
      const next = readSource();
      if (next === currentSource) {
        return;
      }
      currentSource = next;
      apply(next);
    });

    currentSource = readSource();
    apply(currentSource);

    return () => {
      unsubscribe();
      for (const [property, value] of applied) {
        if (value === "") {
          root.style.removeProperty(property);
        } else {
          root.style.setProperty(property, value);
        }
      }
      applied = [];
    };
    // `appearance` is deliberately absent: see the transition-boundary note
    // above. It is read through `latest` instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, source]);

  return null;
}
