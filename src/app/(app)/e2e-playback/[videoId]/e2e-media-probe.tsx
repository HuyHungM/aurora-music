"use client";

import { useEffect } from "react";
import { getDefaultEngine } from "@/lib/player/engine-factory";
import type { MediaDiagnostics } from "@/lib/player/engine";

/**
 * Publishes the real media element's state to `window` for E2E assertions.
 *
 * WHY THIS EXISTS
 *
 * The player owns a media element created with `new Audio()` and never attaches
 * it to the document. There is therefore no `audio` selector, and nothing in
 * the DOM can answer "is audio actually playing?". The controls CAN: the Pause
 * button appears, the seek slider exists, its `max` attribute carries a
 * duration. But all of those describe the UI's belief about playback, and a
 * Play test that asserts on them passes or fails for reasons that have nothing
 * to do with media.
 *
 * That produced a real failure: a missing seek slider timed out, and the test
 * reported NOT_PLAYING for a stream that was playing. The diagnosis was about
 * a slider.
 *
 * So this exposes `PlayerEngine.mediaDiagnostics()` - a read-only snapshot with
 * no `src`, because a googlevideo URL is signed and must never be reachable
 * from a value a test could print.
 *
 * SCOPE
 *
 * Rendered only by `/e2e-playback/[videoId]`, which 404s unless
 * `AURORA_E2E_LIVE_PLAYBACK=1` (see `getE2EPlaybackFixtureAction`). No
 * production route mounts this, no env var is added, and the global is only
 * ever a read function.
 */
export function E2EMediaProbe() {
  useEffect(() => {
    const read = (): MediaDiagnostics | null =>
      getDefaultEngine()?.mediaDiagnostics() ?? null;
    const target = window as unknown as {
      __auroraMediaDiagnostics?: () => MediaDiagnostics | null;
    };
    target.__auroraMediaDiagnostics = read;
    return () => {
      delete target.__auroraMediaDiagnostics;
    };
  }, []);
  return null;
}