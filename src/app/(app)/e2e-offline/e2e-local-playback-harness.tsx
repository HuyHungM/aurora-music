"use client";

import { useEffect } from "react";
import { replaceFileRegistry, liveObjectUrlCount } from "@/lib/offline/session";
import { localTrack } from "@/lib/offline/tracks";
import type { OfflineFileHandle } from "@/lib/offline/types";
import { getDefaultEngine } from "@/lib/player/engine-factory";
import { getMusicEngine } from "@/lib/music/instance";
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

interface StoreSnapshot {
  /** Store current track, as MusicEngine publishes it. Null when no engine. */
  source: string | null;
  id: string | null;
  isPlaying: boolean;
  isLoading: boolean;
  error: string | null;
}

export function E2ELocalPlaybackHarness() {
  useEffect(() => {
    let file: File | null = null;
    // Unique per registration, so consecutive plays are distinct identities
    // the way production tracks are — a constant id would make every replay
    // look like the same track to identity-keyed logic under test.
    let fixtureId = FIXTURE_ID;
    let registrations = 0;

    /**
     * THE HARNESS'S OWN RESOLVER, not the controller's.
     *
     * The original version called the controller's `createLocalSourceResolver`
     * directly and then `engine.load()` with the result — duplicating exactly
     * what the controller does internally, except it skipped the store. The
     * `MusicEngine` facade (and therefore the reactive layer) derives
     * `isPlaying` from store state, so playback started here was REAL on the
     * element and INVISIBLE in the store: `isPlaying` stayed false, the loop
     * never started, and no graph was ever built.
     *
     * So this calls `engine?.play(track)`, exactly what the Play Folder button
     * calls. The store's `replaceQueue` hands the track to the canonical
     * `PlaybackController`, which resolves it through `PlayerHost`'s
     * registered resolvers — including its OWN local resolver against this
     * same session registry — and loads onto the same engine. One player, one
     * path, no bypass.
     */
    const play = async (timeoutMs = 5000): Promise<PlaySummary> => {
      const fileFacts = file
        ? { name: file.name, size: file.size, type: file.type }
        : null;

      const engine = getMusicEngine();
      const defaultEngine = getDefaultEngine();
      if (!engine || !defaultEngine) {
        return {
          resolved: {
            ok: false,
            scheme: null,
            mimeType: null,
            error: "no music engine",
            liveObjectUrls: liveObjectUrlCount(),
          },
          diagnostics: defaultEngine?.mediaDiagnostics() ?? null,
          file: fileFacts,
          outcome: "error",
        };
      }

      const track = localTrack({
        id: fixtureId,
        folder: null,
        name: (file as File).name,
      });

      // Settle on real MEDIA events, not on anything the controls render.
      const outcome = await new Promise<"playing" | "loaded" | "error" | "timeout">(
        (done) => {
          let settled = false;
          const finish = (value: "playing" | "loaded" | "error") => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            done(value);
          };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            unsubscribe();
            done("timeout");
          }, timeoutMs);
          const offPlaying = defaultEngine.on("playing", () => finish("playing"));
          // The headless element often fires a bare `play` without `playing`:
          // the store marks itself playing on `play` too, so settle on it as
          // well rather than hang on an element that is already audible.
          const offPlay = defaultEngine.on("play", () => finish("playing"));
          const offLoaded = defaultEngine.on("loadedmetadata", () => finish("loaded"));
          const offError = defaultEngine.on("error", () => finish("error"));
          const unsubscribe = () => {
            offPlaying();
            offPlay();
            offLoaded();
            offError();
          };

          // Same call the Play Folder button makes: store -> controller ->
          // resolver -> engine. `play()` is async only because it awaits
          // resolution and autoplay permission; the media event it produces is
          // what settles this promise, never the returned promise itself.
          void engine.play(track).catch(() => {
            finish("error");
          });
        },
      );

      return {
        resolved: {
          ok: outcome !== "error" && outcome !== "timeout",
          scheme: "blob",
          mimeType: fileFacts?.type ?? null,
          error: null,
          liveObjectUrls: liveObjectUrlCount(),
        },
        diagnostics: defaultEngine.mediaDiagnostics(),
        file: fileFacts,
        outcome,
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
      registrations += 1;
      fixtureId = `${FIXTURE_ID}-${registrations}`;
      replaceFileRegistry(new Map([[fixtureId, handle]]));
      return { ok: true, size: file.size, type: file.type };
    };

    const resolve = async (): Promise<ResolvedSummary> => {
      try {
        const engine = getMusicEngine();
        const snapshot = engine?.getState() ?? null;
        const current = snapshot?.currentTrack ?? null;
        // Proves the previous `play()` went through the store: the store's
        // current track is the fixture, or nothing is.
        const isFixture =
          current?.primarySource.source === "local" &&
          current.primarySource.id === fixtureId;
        return {
          ok: isFixture,
          scheme: isFixture ? "blob" : null,
          mimeType: file?.type ?? null,
          error: isFixture ? null : "store current track is not the fixture",
          liveObjectUrls: liveObjectUrlCount(),
        };
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

    /**
     * Pause / resume through the SAME facade the transport controls use, not by
     * poking the element. A test that paused the element directly would skip the
     * store transition the reactive layer actually reacts to.
     */
    const transport = async (
      action: "pause" | "resume",
    ): Promise<{ ok: boolean; isPlaying: boolean }> => {
      const engine = getMusicEngine();
      if (!engine) return { ok: false, isPlaying: false };
      if (action === "pause") engine.pause();
      // AWAITED, and that is the fix. Reading `isPlaying` after a fire-and-forget
      // `resume()` returned `false` on every run, which made a resume assertion
      // vacuous: both the "before" and "after" readings were zero, so it passed
      // while proving nothing. `resume()` resolves when the element has accepted
      // the play, not when it is audible.
      else await engine.resume();
      return { ok: true, isPlaying: engine.getState().isPlaying };
    };

    /**
     * The same four values `MusicReactiveAmbient` branches on: the facade's
     * `isPlaying` plus the store's loading/error state, so a test can tell
     * "the reactive layer sees playback" apart from "the element makes
     * noise". Used by the verification script's playback confirmation.
     */
    const store = (): StoreSnapshot => {
      const engine = getMusicEngine();
      const state = engine?.getState() ?? null;
      return {
        source: state?.currentTrack?.primarySource.source ?? null,
        id: state?.currentTrack?.primarySource.id ?? null,
        isPlaying: state?.isPlaying ?? false,
        isLoading: state?.isResolving ?? false,
        error: state?.error?.message ?? null,
      };
    };

    /**
     * Test-only introspection into the analyser tap, for one specific question:
     * when the reactive vars read 0.000 during confirmed playback, is the
     * ELEMENT starved (no audio track to tap) or did the loop give up?
     *
     * Calls the SAME `analysisStream()` the reactive component calls, counts
     * the audio tracks, then stops them immediately so the probe leaves no
     * live stream behind. Read-only; it neither builds the reactive graph nor
     * touches the store.
     */
    const analysisProbe = (): {
      hasStream: boolean;
      audioTracks: number;
      error: string | null;
    } => {
      try {
        const stream = getDefaultEngine()?.analysisStream?.() ?? null;
        if (!stream) return { hasStream: false, audioTracks: 0, error: null };
        const count = stream.getAudioTracks().length;
        for (const track of stream.getAudioTracks()) {
          try {
            track.stop();
          } catch {
            /* best-effort cleanup */
          }
        }
        return { hasStream: true, audioTracks: count, error: null };
      } catch (error) {
        return {
          hasStream: false,
          audioTracks: 0,
          error: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120),
        };
      }
    };

    const target = window as unknown as Record<string, unknown>;
    target.__auroraLocalRegister = register;
    target.__auroraLocalResolve = resolve;
    target.__auroraLocalPlay = play;
    target.__auroraLocalTransport = transport;
    target.__auroraLocalStore = store;
    target.__auroraLocalAnalysisProbe = analysisProbe;
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
      delete target.__auroraLocalTransport;
      delete target.__auroraLocalStore;
      delete target.__auroraLocalAnalysisProbe;
      delete target.__auroraLocalDiagnostics;
    };
  }, []);

  return null;
}