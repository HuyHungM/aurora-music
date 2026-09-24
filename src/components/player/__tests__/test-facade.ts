import { usePlayerStore } from "@/lib/player/store";
import { createMusicEngine } from "@/lib/music/music-engine";
import { createQueueManager } from "@/lib/music/queue-manager";
import { setMusicEngine } from "@/lib/music/instance";

/**
 * Mounts a real MusicEngine facade bound to the real player store for
 * component tests that render UI without PlayerHost. Queue mutations flow
 * through the real QueueManager; search/lookup reject (offline). Call the
 * returned cleanup to shut down and unpublish, mirroring host unmount.
 */
export function mountTestFacade(): () => void {
  const getState = () => usePlayerStore.getState();
  const actions = usePlayerStore.getState();
  const queue = createQueueManager({ getState, actions });
  const engine = createMusicEngine({
    getState,
    actions,
    engine: { on: () => () => undefined },
    search: {
      search: async () => {
        throw new Error("search unavailable in component tests");
      },
    },
    lookup: {
      getTrack: async () => null,
    },
    queue,
    subscribeStore: (listener: () => void) =>
      usePlayerStore.subscribe(() => {
        listener();
      }),
  });
  engine.initialize();
  setMusicEngine(engine);
  return () => {
    engine.shutdown();
    setMusicEngine(null);
  };
}
