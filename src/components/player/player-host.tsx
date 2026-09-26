"use client";

import { useEffect } from "react";
import { getDefaultEngine } from "@/lib/player/engine-factory";
import {
  usePlayerStore,
  setPlaybackController,
  setRecordPlayedAction,
} from "@/lib/player/store";
import { setupMediaSession } from "@/lib/player/media-session";
import {
  PlaybackPersistenceController,
  isSeekJump,
} from "@/lib/player/persistence";
import { createPlaybackResolver } from "@/lib/playback/resolver";
import { createServerSourceResolver } from "@/lib/playback/client-resolver";
import { createPlaybackController } from "@/lib/playback/controller";
import { createUnifiedSearch } from "@/lib/music/unified-search";
import { createMusicEngine } from "@/lib/music/music-engine";
import type { MusicEngine } from "@/lib/music/music-engine";
import { createQueueManager } from "@/lib/music/queue-manager";
import { setMusicEngine } from "@/lib/music/instance";
import { extractorManager } from "@/lib/providers/extractor-manager";
import { logger } from "@/lib/diagnostics/logger";
import { recordPlayedAction } from "@/app/actions/playback";
import { resolveAudioSourceAction } from "@/app/actions/playback-resolve";
import {
  clearPlaybackStateAction,
  getPlaybackStateAction,
  getSessionUserIdAction,
  resolvePlaybackTrackAction,
  savePlaybackStateAction,
} from "@/app/actions/playback-state";
import { MiniPlayer } from "./mini-player";
import { PlayerBar } from "./player-bar";
import { QueuePanel } from "./queue-panel";
import { FullPlayer } from "./full-player";
import { createRadioSession } from "@/lib/radio/session";
import { setRadioSession } from "@/lib/radio/instance";
import { createInfiniteListeningCoordinator } from "@/lib/listening/coordinator";
import { setKeepListeningCoordinator } from "@/lib/listening/instance";
import { getKeepListeningAction } from "@/app/actions/listening";
import { PlaybackOwnershipHost } from "./playback-ownership-host";
import { isForeignPlaybackOwnerActive } from "@/lib/multi-tab/instance";

/**
 * Mounts the single app audio engine and the playback UI. Rendered from the
 * (app) layout, which stays a server component.
 *
 * Authenticated startup lifecycle (Phase 7D):
 *   bind engine → resolve session → fetch persisted state →
 *   resolve track via provider → restore safe position →
 *   mark persistence ready → start checkpoint timer.
 * User intent always wins over a pending restore; all persistence
 * failures are non-fatal to playback.
 */
export function PlayerHost() {
  useEffect(() => {
    // Set by the cleanup below. Guards the in-flight session lookups against
    // re-arming an instance that has already been torn down (Phase 49).
    let tornDown = false;

    setRecordPlayedAction(recordPlayedAction);

    const engine = getDefaultEngine();
    if (!engine) {
      return;
    }
    const dispose = usePlayerStore.getState().bindEngine(engine);
    const disposeMediaSession = setupMediaSession(usePlayerStore.getState);

    // Phase 10: one lifecycle-owned PlaybackController bridging resolver
    // output into the existing engine. Resolution runs server-side; the
    // browser only ever receives serialized AudioSources.
    // Declared before the facade so panels can observe controller-owned
    // recovery through the store (intermediate failures stay internal;
    // only final outcomes surface via reportPlaybackError/clearError).
    let music: MusicEngine | null = null;
    const controller = createPlaybackController({
      resolver: createPlaybackResolver([
        createServerSourceResolver(resolveAudioSourceAction),
      ]),
      engine,
      reportError: (error) => {
        usePlayerStore.getState().reportPlaybackError(error.kind, error.message);
      },
      // Recovery takes over error surfacing while a cycle is active; the
      // final outcome (or a successful resume) determines the visible state.
      clearError: () => {
        usePlayerStore.getState().clearError();
      },
    });
    setPlaybackController(controller);

    // Phase 13: one lifecycle-owned MusicEngine facade over the store,
    // engine signals, unified search, and extractor manager. No duplicated
    // state; shutdown on unmount keeps StrictMode remounts singular.
    // Phase 14: state is read fresh per call (Zustand replaces the state
    // object on every set) and every queue mutation flows through the
    // single QueueManager boundary.
    const storePort = {
      getState: () => usePlayerStore.getState(),
      actions: usePlayerStore.getState(),
      subscribeStore: (listener: () => void) =>
        usePlayerStore.subscribe(() => {
          listener();
        }),
    };
    const unifiedSearch = createUnifiedSearch(extractorManager);
    const queueManager = createQueueManager(storePort);
    music = createMusicEngine({
      ...storePort,
      engine,
      search: {
        search: (query, options) => unifiedSearch.search(query, options),
      },
      lookup: {
        getTrack: (ref) => extractorManager.getTrack(ref),
      },
      queue: queueManager,
    });
    music.initialize();
    setMusicEngine(music);
    logger.info("PlayerHost initialized", { event: "app_initialized" });

    const persistence = new PlaybackPersistenceController({
      getPlaybackStateAction,
      savePlaybackStateAction,
      clearPlaybackStateAction,
      resolveTrack: async (provider, providerTrackId) => {
        const result = await resolvePlaybackTrackAction(
          provider,
          providerTrackId,
        );
        return result.track;
      },
      getStoreSnapshot: () => {
        const s = usePlayerStore.getState();
        return {
          currentTrack: s.currentTrack,
          currentTime: s.currentTime,
          isPlaying: s.isPlaying,
          userActionGeneration: s.userActionGeneration,
          queue: s.queue,
          playOrder: s.playOrder,
          position: s.position,
          shuffle: s.shuffle,
          repeat: s.repeat,
          volume: s.volume,
          muted: s.muted,
        };
      },
      applyRestore: (track, position) => {
        usePlayerStore.getState().restoreTrack(track, position);
      },
      applyQueueRestore: (restored) => {
        usePlayerStore.getState().restoreQueueSnapshot(restored);
      },
      setInitState: (state) => {
        usePlayerStore.getState().setPersistenceInitState(state);
      },
      // A tab that has yielded to a live foreign owner is a background
      // session, not the live one. Letting it write would let a stale tab
      // decide what the next page load restores — the open half of the
      // problem named in `playback-ownership.ts`. Read lazily at write time
      // because the machine is created by a child effect.
      shouldPersistSession: () => !isForeignPlaybackOwnerActive(),
    });

    // Kick off authenticated restore. Anonymous startup resolves to
    // userId null and marks persistence ready without any writes.
    //
    // Phase 49: `persistence` is constructed inside this effect, so this
    // in-flight lookup can resolve AFTER the cleanup below has run (React
    // StrictMode's setup -> cleanup -> setup, or an HMR edit). Calling
    // `initialize` on that orphaned instance clears the `disposed` flag that
    // `shutdown()` set, so it starts a 12 s checkpoint interval that nothing
    // can ever clear, and its `applyRestore`/`applyQueueRestore` closures
    // still write into the live store. The flag makes teardown terminal.
    void getSessionUserIdAction()
      .then((result) => {
        if (tornDown) return;
        return persistence.initialize(result.ok ? result.userId : null);
      })
      .catch(() => {
        if (tornDown) return;
        return persistence.initialize(null);
      });

    // Phase 41: one lifecycle-owned radio session. Memory-only: a
    // reload drops the session while the persisted queue survives as
    // ordinary entries with no regeneration. The session never touches
    // playback or queue state directly — every mutation flows through
    // the MusicEngine facade below.
    const radioSession = createRadioSession();
    setRadioSession(radioSession);

    // Phase 47: one lifecycle-owned generic queue continuation
    // coordinator. Memory-only, like radio: a reload drops the context
    // while the persisted queue survives as ordinary entries with no
    // regeneration. It stands down entirely while a radio station owns the
    // queue, so the two systems can never compete (§55).
    const keepListening = createInfiniteListeningCoordinator({
      isExclusiveContinuationActive: () => radioSession.getState().active,
    });
    setKeepListeningCoordinator(keepListening);
    // Hydrate the persisted preference. Anonymous listeners resolve to the
    // OFF default, so continuation is never silently on for someone who
    // cannot express a preference.
    void getKeepListeningAction()
      .then((result) => {
        if (tornDown) return;
        if (result.ok) {
          keepListening.hydrate(result.enabled, result.authenticated);
        }
      })
      .catch(() => undefined);

    // Canonical queue keys for radio override detection (identity per
    // entry; duplicates kept positionally like React occurrence keys).
    const queueKeysOf = (tracks: { provider: string; id: string; providerTrackId?: string }[]) =>
      tracks.map((track) => `${track.provider}:${track.providerTrackId ?? track.id}`);

    // Track-change and pause checkpoints. prevState gives the old track
    // and its latest position atomically, so a checkpoint can never
    // associate the old position with the new track.
    // Queue-shape changes (queue/playOrder/cursor/shuffle/repeat) feed
    // debounced full-queue snapshots; time/volume-only updates are
    // ignored here (position cadence belongs to the checkpoints above).
    // The same queue-identity change drives radio override detection
    // and continuous generation.
    const unsubscribeStore = usePlayerStore.subscribe((state, prev) => {
      const trackChanged = state.currentTrack !== prev.currentTrack;
      if (trackChanged && prev.currentTrack) {
        persistence.notifyTrackChanged(
          prev.currentTrack,
          prev.currentTime,
        );
        // Only the track-change checkpoint is handled here. The
        // queue-shape, preference and radio blocks below still describe
        // this same mutation and must keep running: replaceQueue,
        // playTrack, playCollection and clearQueue each set queue,
        // playOrder and currentTrack in one set(), so returning early used
        // to hide every manual override from the radio session. The result
        // was a cleared queue being silently refilled by a station the user
        // had already ended — contradicting the spec's "manual
        // play/replace/clear always wins, and clearing never refills".
      } else {
        if (prev.isPlaying && !state.isPlaying && state.currentTrack) {
          persistence.notifyPaused(state.currentTrack, state.currentTime);
        }
        // Explicit seeks on the same track surface as a large currentTime
        // discontinuity (natural timeupdate deltas are throttled to 250ms).
        // Covered by the debounced queue snapshot path via notifyQueueChanged.
        if (
          !trackChanged &&
          state.currentTrack &&
          state.currentTrack === prev.currentTrack &&
          isSeekJump(prev.currentTime, state.currentTime)
        ) {
          persistence.notifyQueueChanged();
        }
      }
      const queueIdentityChanged = state.queue !== prev.queue;
      if (
        queueIdentityChanged ||
        state.playOrder !== prev.playOrder ||
        state.position !== prev.position ||
        state.shuffle !== prev.shuffle ||
        state.repeat !== prev.repeat
      ) {
        persistence.notifyQueueChanged();
      }
      // Volume/mute ride the same session snapshot and the same debounced
      // write; a slider drag coalesces into one request.
      if (state.volume !== prev.volume || state.muted !== prev.muted) {
        persistence.notifyPreferencesChanged();
      }
      // Radio watches every queue/cursor/order change: identity changes
      // feed override detection, while cursor and order advances feed
      // continuous generation (next/previous never end a session).
      //
      // Phase 47 "Keep listening" observes the SAME single subscription
      // rather than adding a second one. A second subscriber would
      // evaluate overrides in an order that depends on registration
      // order, so a manual replace could be seen as an override by one
      // coordinator and as an append by the other. One subscription, one
      // deterministic evaluation, both coordinators.
      if (
        music &&
        (queueIdentityChanged ||
          state.playOrder !== prev.playOrder ||
          state.position !== prev.position)
      ) {
        if (queueIdentityChanged) {
          const queueKeys = queueKeysOf(state.queue);
          radioSession.noteQueueChanged(queueKeys);
          keepListening.noteQueueChanged(queueKeys);
        }
        radioSession.maybeExtend(music);
        keepListening.maybeContinue(music);
      }
    });

    // Best-effort flush when the page hides; never relied upon alone
    // (mutation checkpoints are the primary path, not unload).
    const handleVisibilityHidden = () => {
      if (document.visibilityState === "hidden") {
        persistence.flushQueueSnapshot();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityHidden);
    window.addEventListener("pagehide", handlePageHide);

    function handlePageHide() {
      persistence.flushQueueSnapshot();
    }

    return () => {
      // Terminal for this effect's instances: nothing created above may be
      // re-armed after this point, including by a promise already in flight.
      tornDown = true;
      document.removeEventListener("visibilitychange", handleVisibilityHidden);
      window.removeEventListener("pagehide", handlePageHide);
      unsubscribeStore();
      keepListening.end();
      setKeepListeningCoordinator(null);
      radioSession.end();
      setRadioSession(null);
      persistence.shutdown();
      music?.shutdown();
      setMusicEngine(null);
      music = null;
      controller.shutdown();
      setPlaybackController(null);
      dispose();
      disposeMediaSession?.();
      usePlayerStore.getState().bindEngine(null);
      logger.info("PlayerHost shut down", { event: "app_shutdown" });
    };
  }, []);

  return (
    <>
      {/* Phase 52: which tab is allowed to be audible. Mounted here so its
          lifecycle is tied to the engine's, but it holds no playback state of
          its own - it observes this store and calls its own pause(). */}
      <PlaybackOwnershipHost />
      <MiniPlayer />
      <PlayerBar />
      <QueuePanel />
      <FullPlayer />
    </>
  );
}
