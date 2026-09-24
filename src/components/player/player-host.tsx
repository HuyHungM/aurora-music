"use client";

import { useEffect } from "react";
import { getDefaultEngine } from "@/lib/player/engine-factory";
import {
  usePlayerStore,
  setPlaybackController,
  setRecordPlayedAction,
} from "@/lib/player/store";
import { setupMediaSession } from "@/lib/player/media-session";
import { PlaybackPersistenceController } from "@/lib/player/persistence";
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
        };
      },
      applyRestore: (track, position) => {
        usePlayerStore.getState().restoreTrack(track, position);
      },
      setInitState: (state) => {
        usePlayerStore.getState().setPersistenceInitState(state);
      },
    });

    // Kick off authenticated restore. Anonymous startup resolves to
    // userId null and marks persistence ready without any writes.
    void getSessionUserIdAction()
      .then((result) =>
        persistence.initialize(result.ok ? result.userId : null),
      )
      .catch(() => persistence.initialize(null));

    // Track-change and pause checkpoints. prevState gives the old track
    // and its latest position atomically, so a checkpoint can never
    // associate the old position with the new track.
    const unsubscribeStore = usePlayerStore.subscribe((state, prev) => {
      const trackChanged = state.currentTrack !== prev.currentTrack;
      if (trackChanged && prev.currentTrack) {
        persistence.notifyTrackChanged(
          prev.currentTrack,
          prev.currentTime,
        );
        return;
      }
      if (prev.isPlaying && !state.isPlaying && state.currentTrack) {
        persistence.notifyPaused(state.currentTrack, state.currentTime);
      }
    });

    return () => {
      unsubscribeStore();
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
      <MiniPlayer />
      <PlayerBar />
      <QueuePanel />
      <FullPlayer />
    </>
  );
}
