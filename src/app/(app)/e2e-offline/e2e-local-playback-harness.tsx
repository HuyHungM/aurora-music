"use client";

import { useEffect } from "react";
import { createLocalSourceResolver } from "@/lib/offline/local-resolver";
import { replaceFileRegistry, liveObjectUrlCount } from "@/lib/offline/session";
import { localTrack } from "@/lib/offline/tracks";
import type { OfflineFileHandle } from "@/lib/offline/types";
import { withPlaybackSource } from "@/lib/player/playback-source";
import { getDefaultEngine } from "@/lib/player/engine-factory";
import { sourceSchemeOf } from "@/lib/player/engine";
import type { MediaDiagnostics } from "@/lib/player/engine";

/**
 * Drives the REAL local playback chain from a file whose bytes the test picks.
 *
 * WHY THIS EXISTS. The failure this was built for was reported as
 * `playback_recovery_failed` with `category: "source"` and no native detail,
 * which is indistinguishable across every cause that produces
 * `MediaError.code === 4`. The File System Access API cannot be driven from a
 * browser test — it needs a user gesture and a real folder picker — so the local
 * playback path had no automated coverage at all, and every hypothesis had to be
 * settled by reading code rather than by observing it. Measured in Chromium:
 *
 *   code 4 + "Media load rejected by URL safety check"  -> revoked blob URL
 *   code 4 + "Format error"                             -> empty or truncated file
 *   code 4 + "DEMUXER_ERROR_COULD_NOT_OPEN"             -> undecodable container
 *
 * Without the message, all three were the same log line.
 *
 * NOTHING FAKED EXCEPT THE BYTES. `register` puts a structural
 * `OfflineFileHandle` in the SAME registry a real scan populates, `resolve`
 * calls the SAME `createLocalSourceResolver`, and `play` loads through the SAME
 * `PlayerEngine` onto the same `new Audio()` element the app owns.
 *
 * NOTHING LEAKS. Object URLs are never returned, logged, or put on `window` —
 * only their scheme. File contents are never returned.
 *
 * SCOPE. Rendered only by `/e2e-offline`, which 404s without the E2E flag. No
 * production route mounts this, no env var is added, and every global is removed
 * on unmount.
 */

const FIXTURE_ID = "e2e-local-fixture";

interface ResolvedSummary {
  ok: boolean;
  scheme: string | null;
  /** Whether the resolver mapped a MIME for this file. */
  mimeType: string | null;
  error: string | null;
  liveObjectUrls: number;
}

interface PlaySummary {
  resolved: ResolvedSummary;
  diagnostics: MediaDiagnostics | null;
  file: { name: string; size: number; type: string } | null;
  outcome: "playing" | "loaded" | "error" | "timeout";
}

export function E2ELocalPlaybackHarness() {
  useEffect(() => {
    let file: File | null = null;
    const resolver = createLocalSourceResolver();

    /** Resolves once, keeping the URL in a closure so it is never exposed. */
    const resolveOnce = async () => {
      const source = await resolver.resolveSource({
        source: "local",
        id: FIXTURE_ID,
      } as never);
      return {
        source,
        summary: {
          ok: true as const,
          scheme: sourceSchemeOf(source.url),
          mimeType: source.mimeType ?? null,
          error: null,
          liveObjectUrls: liveObjectUrlCount(),
        },
      };
    };

    const register = (spec: {
      bytes: number[];
      name: string;
      type?: string;
    }): { ok: boolean; size: number; type: string } => {
      file = new File([new Uint8Array(spec.bytes)], spec.name, {
        type: spec.type ?? "",
      });
      const handle: OfflineFileHandle = {
        kind: "file",
        name: spec.name,
        getFile: async () => file as File,
      };
      // Exactly what a scan does: install a registry holding the handle.
      replaceFileRegistry(new Map([[FIXTURE_ID, handle]]));
      return { ok: true, size: file.size, type: file.type };
    };

    const resolve = async (): Promise<ResolvedSummary> => {
      try {
        return (await resolveOnce()).summary;
      } catch (error) {
        return {
          ok: false,
          scheme: null,
          mimeType: null,
          error: error instanceof Error ? error.message : String(error),
          liveObjectUrls: liveObjectUrlCount(),
        };
      }
    };

    const play = async (timeoutMs = 5000): Promise<PlaySummary> => {
      const fileFacts = file
        ? { name: file.name, size: file.size, type: file.type }
        : null;

      let resolved: Awaited<ReturnType<typeof resolveOnce>>;
      try {
        resolved = await resolveOnce();
      } catch (error) {
        return {
          resolved: {
            ok: false,
            scheme: null,
            mimeType: null,
            error: error instanceof Error ? error.message : String(error),
            liveObjectUrls: liveObjectUrlCount(),
          },
          diagnostics: null,
          file: fileFacts,
          outcome: "error",
        };
      }

      const engine = getDefaultEngine();
      if (!engine) {
        throw new Error("no default engine");
      }

      const track = withPlaybackSource(
        localTrack({ id: FIXTURE_ID, folder: null, name: (file as File).name }),
        resolved.source,
      );

      // Settle on real MEDIA events, not on anything the controls render.
      const outcome = await new Promise<"playing" | "loaded" | "error" | "timeout">(
        (done) => {
          let settled = false;
          const finish = (value: "playing" | "loaded" | "error") => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            offPlaying();
            offLoaded();
            offError();
            done(value);
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            offPlaying();
            offLoaded();
            offError();
            done("timeout");
          }, timeoutMs);
          const offPlaying = engine.on("playing", () => finish("playing"));
          const offLoaded = engine.on("loadedmetadata", () => finish("loaded"));
          const offError = engine.on("error", () => finish("error"));

          engine.load(track, true);
        },
      );

      return {
        resolved: resolved.summary,
        diagnostics: engine.mediaDiagnostics(),
        file: fileFacts,
        outcome,
      };
    };

    const target = window as unknown as Record<string, unknown>;
    target.__auroraLocalRegister = register;
    target.__auroraLocalResolve = resolve;
    target.__auroraLocalPlay = play;
    // A read-only window onto the REAL element's state, so a test can watch
    // `readyState` climb and `currentTime` advance rather than assert that a
    // button exists. Defined here rather than reusing the `/e2e-playback`
    // probe because that one is mounted by a different route.
    target.__auroraLocalDiagnostics = () =>
      getDefaultEngine()?.mediaDiagnostics() ?? null;
    return () => {
      delete target.__auroraLocalRegister;
      delete target.__auroraLocalResolve;
      delete target.__auroraLocalPlay;
      delete target.__auroraLocalDiagnostics;
    };
  }, []);

  return null;
}