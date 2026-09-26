import type { Track, TrackIdentity } from "@/lib/domain";
import type { MusicEngine } from "@/lib/music/music-engine";
import { identityToTrack } from "@/lib/music/identity-track";
import {
  allKeysOf,
  identityKeyOf,
  relateQueues,
} from "@/lib/music/queue-relation";
import {
  extendRadioBatchAction,
  startArtistRadioAction,
  startDiscoveryRadioAction,
  startTrackRadioAction,
  type ExtendRadioInput,
} from "@/app/actions/radio";
import {
  RADIO_EXTEND_BATCH,
  RADIO_PLAYED_CAP,
  RADIO_SESSION_TRACK_CAP,
} from "./service";

/**
 * Client-side radio session (memory-only, never persisted).
 *
 * Owns the active station (mode/seed/label), played-key memory, and the
 * continuous-generation loop. Owns NO playback, NO audio, and NO queue
 * state — every mutation flows through MusicEngine/QueueManager, which
 * remain the sole authorities.
 *
 * Override rule (user control always wins): the session watches queue
 * key-signatures. Radio's own replace/append operations are flagged
 * synchronously around the engine call; any other wholesale replacement
 * or clear ends the session. Pure additions, removals, and reorders keep
 * it alive (radio tracks are ordinary queue items). A reload drops the
 * session entirely: restored radio tracks persist as ordinary entries
 * with no regeneration (§40).
 */

export type RadioSessionMode = "track" | "artist" | "discovery";

/** Remaining tracks at/below which the next batch is generated. */
export const RADIO_EXTEND_THRESHOLD = 2;
/** Consecutive empty batches before the station is declared exhausted. */
export const RADIO_EXHAUSTED_AFTER_EMPTY = 2;

export interface RadioSeedTrack {
  provider: string;
  providerTrackId: string;
}

export interface RadioSeedArtist {
  provider: string;
  providerArtistId: string;
  name: string;
}

export interface RadioLabel {
  key: string;
  params?: Record<string, string | number>;
}

export interface RadioStatus {
  active: boolean;
  mode: RadioSessionMode | null;
  /** Localizable label reference (never internals, never raw provider text). */
  label: RadioLabel | null;
  generating: boolean;
  exhausted: boolean;
  /** Translation key for the user-facing error, if any. */
  error: string | null;
}

export interface RecentStation {
  mode: RadioSessionMode;
  label: RadioLabel;
  startedAt: number;
}

interface SessionState extends RadioStatus {
  seedTrack: RadioSeedTrack | null;
  seedArtist: RadioSeedArtist | null;
  playedKeys: string[];
  emptyBatches: number;
  generatedTotal: number;
  recent: RecentStation[];
}

const INITIAL_STATE: SessionState = {
  active: false,
  mode: null,
  label: null,
  generating: false,
  exhausted: false,
  error: null,
  seedTrack: null,
  seedArtist: null,
  playedKeys: [],
  emptyBatches: 0,
  generatedTotal: 0,
  recent: [],
};

export function createRadioSession() {
  let state: SessionState = { ...INITIAL_STATE, playedKeys: [], recent: [] };
  const listeners = new Set<() => void>();
  // Set while the session itself mutates the queue (synchronous engine
  // calls), so the watcher never mistakes its own appends for overrides.
  let ownMutation = false;
  // Expected queue signature after the session's last mutation.
  let expectedSig: string[] | null = null;

  function emit(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function set(patch: Partial<SessionState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function rememberPlayed(tracks: Array<TrackIdentity | Track>): void {
    const keys = [...state.playedKeys];
    for (const track of tracks) {
      for (const key of allKeysOf(track)) {
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
    }
    set({ playedKeys: keys.slice(-RADIO_PLAYED_CAP) });
  }

  function snapshotQueue(engine: MusicEngine): string[] {
    return engine.queue.items.map(identityKeyOf);
  }

  function sameLabel(a: RadioLabel, b: RadioLabel): boolean {
    return (
      a.key === b.key &&
      JSON.stringify(a.params ?? {}) === JSON.stringify(b.params ?? {})
    );
  }

  async function startFromTracks(
    engine: MusicEngine,
    mode: RadioSessionMode,
    label: RadioLabel,
    tracks: Track[],
    seedTrack: RadioSeedTrack | null,
    seedArtist: RadioSeedArtist | null,
  ): Promise<boolean> {
    if (tracks.length === 0) {
      set({ error: "radio.couldNotStart" });
      return false;
    }
    ownMutation = true;
    try {
      engine.playCollection(tracks, 0);
    } finally {
      ownMutation = false;
    }
    rememberPlayed(tracks);
    expectedSig = tracks.map(identityKeyOf);
    const recent: RecentStation[] = [
      { mode, label, startedAt: Date.now() },
      ...state.recent.filter(
        (entry) => entry.mode !== mode || !sameLabel(entry.label, label),
      ),
    ].slice(0, 5);
    set({
      active: true,
      mode,
      label,
      generating: false,
      exhausted: false,
      error: null,
      seedTrack,
      seedArtist,
      emptyBatches: 0,
      generatedTotal: tracks.length,
      recent,
    });
    // The start mutation itself never triggers generation (the session
    // activates after it), so kick once here when already running low.
    maybeExtend(engine);
    return true;
  }

  function maybeExtend(engine: MusicEngine): void {
    if (!state.active || state.generating || state.exhausted) {
      return;
    }
    const length = engine.queue.length;
    if (length === 0) {
      return;
    }
    const remaining = length - engine.queue.currentIndex - 1;
    if (remaining <= RADIO_EXTEND_THRESHOLD) {
      void extend(engine);
    }
  }

  async function extend(engine: MusicEngine): Promise<void> {
    if (!state.active || state.generating || state.exhausted) {
      return;
    }
    if (state.generatedTotal >= RADIO_SESSION_TRACK_CAP) {
      set({ exhausted: true });
      return;
    }
    const queueKeys = snapshotQueue(engine);
    const exclude = [...new Set([...state.playedKeys, ...queueKeys])];
    const input: ExtendRadioInput = {
      mode: state.mode as RadioSessionMode,
      ...(state.seedTrack ? { seedTrack: state.seedTrack } : {}),
      ...(state.seedArtist ? { seedArtist: state.seedArtist } : {}),
      excludeKeys: exclude.slice(-RADIO_PLAYED_CAP),
      limit: RADIO_EXTEND_BATCH,
    };
    set({ generating: true, error: null });
    let result: Awaited<ReturnType<typeof extendRadioBatchAction>>;
    try {
      result = await extendRadioBatchAction(input);
    } catch {
      result = { ok: false, error: "radio.extendError" };
    }
    if (!state.active) {
      return;
    }
    if (!result || !result.ok) {
      // Server English stays server-side; the UI renders the key below.
      set({ generating: false, error: "radio.extendError" });
      return;
    }
    if (result.batch.tracks.length === 0) {
      const emptyBatches = state.emptyBatches + 1;
      const exhausted = emptyBatches >= RADIO_EXHAUSTED_AFTER_EMPTY;
      set({
        generating: false,
        emptyBatches,
        exhausted,
      });
      if (!exhausted) {
        // A generation skipped while this one was in flight (or a fresh
        // trigger landing mid-flight) must still be honored: re-check.
        maybeExtend(engine);
      }
      return;
    }
    ownMutation = true;
    try {
      for (const track of result.batch.tracks) {
        engine.queue.add(track);
      }
    } finally {
      ownMutation = false;
    }
    rememberPlayed(result.batch.tracks);
    expectedSig = snapshotQueue(engine);
    set({
      generating: false,
      emptyBatches: 0,
      exhausted: result.batch.exhausted && result.batch.tracks.length === 0,
      generatedTotal: state.generatedTotal + result.batch.tracks.length,
    });
    // Appends grow the queue, but a trigger that landed mid-flight still
    // deserves evaluation once this batch lands.
    maybeExtend(engine);
  }

  return {
    getState(): SessionState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async startTrackRadio(
      engine: MusicEngine,
      track: Track,
      label: RadioLabel,
    ): Promise<boolean> {
      const seedTrack: RadioSeedTrack = {
        provider: track.provider,
        providerTrackId: track.providerTrackId ?? track.id,
      };
      set({ generating: true, error: null });
      let result: Awaited<ReturnType<typeof startTrackRadioAction>>;
      try {
        result = await startTrackRadioAction(seedTrack.provider, seedTrack.providerTrackId);
      } catch {
        result = { ok: false, error: "radio.couldNotStart" };
      }
      if (!result.ok) {
        set({ generating: false, error: "radio.couldNotStart" });
        return false;
      }
      return startFromTracks(
        engine,
        "track",
        label,
        result.station.tracks,
        seedTrack,
        null,
      );
    },

    async startArtistRadio(
      engine: MusicEngine,
      artist: { provider: string; providerArtistId?: string; id: string; name: string },
      label: RadioLabel,
    ): Promise<boolean> {
      const seedArtist: RadioSeedArtist = {
        provider: artist.provider,
        providerArtistId: artist.providerArtistId ?? artist.id,
        name: artist.name,
      };
      set({ generating: true, error: null });
      let result: Awaited<ReturnType<typeof startArtistRadioAction>>;
      try {
        result = await startArtistRadioAction(seedArtist.provider, seedArtist.providerArtistId);
      } catch {
        result = { ok: false, error: "radio.couldNotStart" };
      }
      if (!result.ok || result.station.tracks.length === 0) {
        set({
          generating: false,
          error: result.ok ? "radio.noArtistTracks" : "radio.couldNotStart",
        });
        return false;
      }
      return startFromTracks(
        engine,
        "artist",
        label,
        result.station.tracks,
        null,
        seedArtist,
      );
    },

    async startDiscoveryRadio(engine: MusicEngine, label: RadioLabel): Promise<boolean> {
      set({ generating: true, error: null });
      let result: Awaited<ReturnType<typeof startDiscoveryRadioAction>>;
      try {
        result = await startDiscoveryRadioAction();
      } catch {
        result = { ok: false, error: "radio.couldNotStart" };
      }
      if (!result.ok || result.station.tracks.length === 0) {
        set({
          generating: false,
          error: result.ok ? "radio.nothingToPlay" : "radio.couldNotStart",
        });
        return false;
      }
      return startFromTracks(
        engine,
        "discovery",
        label,
        result.station.tracks,
        null,
        null,
      );
    },

    /**
     * Called with the live queue keys on every queue-identity change.
     * Pure additions/removals/reorders keep the session alive; wholesale
     * replacement or clearing ends it (manual playback wins, cleared
     * queues are never silently refilled).
     */
    noteQueueChanged(queueKeys: string[]): void {
      if (!state.active) {
        return;
      }
      if (ownMutation) {
        expectedSig = queueKeys;
        return;
      }
      if (expectedSig === null) {
        expectedSig = queueKeys;
        return;
      }
      const relation = relateQueues(expectedSig, queueKeys);
      if (relation === "replaced") {
        set({ ...INITIAL_STATE, playedKeys: [], recent: state.recent });
        return;
      }
      expectedSig = queueKeys;
    },

    /**
     * Called on queue-identity change once override detection has run.
     * Appends the next batch when the queue runs low.
     */
    maybeExtend,

    end(): void {
      if (!state.active) {
        return;
      }
      set({ ...INITIAL_STATE, playedKeys: [], recent: state.recent });
    },

    /** Test/seam helper: the expected queue signature. */
    getExpectedSig(): string[] | null {
      return expectedSig;
    },
  };
}

export type RadioSession = ReturnType<typeof createRadioSession>;

/** Converts an engine identity to a queue-ready Track (sources carried). */
export function identityToQueueTrack(identity: TrackIdentity): Track {
  return identityToTrack(identity);
}
