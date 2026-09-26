/**
 * The one EQ state (Phase 53 addendum, §42).
 *
 * A MODULE-LEVEL STORE rather than React context, and the reason is §42 read
 * strictly: Settings, the player's compact control and the full-screen player
 * must not be three states that agree by luck. A context provider would make
 * every one of those surfaces responsible for being inside the provider, and
 * the audio graph - which is not React at all - would need a bridge to read it.
 *
 * So the state lives here, the graph subscribes to it, and the UI reads it
 * through `useEq()`. There is exactly one `config` object in the application
 * and no code path writes to it except the actions below.
 *
 * IT IS NOT PART OF THE PLAYBACK STORE, deliberately. Nothing in
 * `PlaybackController`, `PlayerEngine`, the queue or the playback session
 * snapshot imports this file, and there is a quality gate that fails the build
 * if one starts to. That is what makes §31 and §32 true by construction: a
 * track change, a queue transition, a playlist, a radio seed, an autoplay
 * continuation and a resolver retry all travel paths that cannot reach EQ state,
 * so none of them can reset it.
 */

import {
  DEFAULT_EQ,
  EQ_BAND_FREQUENCIES,
  autoPreampDb,
  clampPreampDb,
  cloneBands,
  effectiveGraphState,
  headroomSaturated,
  isPresetApplied,
  presetPreampDb,
  quantizeBandGain,
  requiredPreampDb,
  resetEQ,
  resolvePreampDb,
  selectPreset,
  setBandGain,
  type EQBand,
  type EQConfig,
  type EQPresetId,
} from "./eq";
import { getEqGraph, type EqUnsupportedReason } from "./eq-graph";

export type EqSaveStatus = "idle" | "saving" | "saved" | "failed";

export interface EqState {
  config: EQConfig;
  /** Whether the graph is actually processing audio. */
  engaged: boolean;
  /** Why not, when `engaged` is false and a reason is known. */
  unsupportedReason: EqUnsupportedReason | null;
  /** Transient A/B override (§23). The stored config is NOT modified. */
  comparing: boolean;
  saveStatus: EqSaveStatus;
  /** Bumped on every committed change so effects can react without deep compares. */
  revision: number;
}

function initialState(): EqState {
  return {
    config: { ...DEFAULT_EQ, bands: cloneBands(DEFAULT_EQ.bands) },
    engaged: false,
    unsupportedReason: null,
    comparing: false,
    saveStatus: "idle",
    revision: 0,
  };
}

let state: EqState = initialState();
const listeners = new Set<() => void>();

export function getEqState(): EqState {
  return state;
}

export function subscribeEq(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setState(next: Partial<EqState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) {
    listener();
  }
}

/* ==========================================================================
   DERIVED VALUES - computed, never stored
   ========================================================================== */

/**
 * The preamp that is actually in effect.
 *
 * A/B (§23) reports 0, because in that state nothing is being applied and
 * showing a number that is not being used would be a lie in the one moment the
 * user is comparing.
 *
 * `comparing` is a parameter rather than a read of module state, so that a
 * caller deriving a view for a specific configuration cannot be misled by a
 * different one being current. The default reads the live value, which is what
 * the store's own callers want.
 */
export function effectivePreampDb(
  config: EQConfig = state.config,
  comparing: boolean = state.comparing,
): number {
  if (comparing || !config.enabled) {
    return 0;
  }
  return resolvePreampDb(config);
}

/** The bands actually in effect - all 0 dB when bypassed or comparing. */
export function effectiveBands(
  config: EQConfig = state.config,
  comparing: boolean = state.comparing,
): EQBand[] {
  return effectiveGraphState(
    comparing ? { ...config, enabled: false } : config,
  ).bands;
}

/**
 * The preamp a preset DECLARES, for display (§38).
 *
 * Separate from `effectivePreampDb` on purpose. With Aurora V-Shape selected
 * the interface says "Preamp: -3.5 dB" because that is the preset's specified
 * figure; it does not show a re-derived number that would move with the curve.
 * When automatic headroom is on instead, the interface says "Auto" and shows
 * the computed value - a labelled, honest figure rather than a slider sitting
 * on a value the system is about to overrule.
 */
export function declaredPreampDb(presetId: EQPresetId = state.config.presetId): number {
  return presetPreampDb(presetId);
}

/** The figure Auto Headroom computes for a curve, at the live sample rate. */
export function autoPreampFor(bands: readonly EQBand[]): number {
  return autoPreampDb(bands, getEqGraph().sampleRate ?? undefined);
}

/** What Auto Headroom would need for a curve, before clamping. */
export function requiredPreampFor(bands: readonly EQBand[]): number {
  return requiredPreampDb(bands, getEqGraph().sampleRate ?? undefined);
}

/** Whether Auto Headroom cannot express its own answer for a curve. */
export function isHeadroomSaturatedFor(bands: readonly EQBand[]): boolean {
  return headroomSaturated(bands, getEqGraph().sampleRate ?? undefined);
}

/** Whether Auto Headroom cannot express its own answer within the range. */
export function isHeadroomSaturated(): boolean {
  return isHeadroomSaturatedFor(state.config.bands);
}

/* ==========================================================================
   THE GRAPH BRIDGE
   ========================================================================== */

/**
 * Pushes the current configuration into the audio graph.
 *
 * Called after every committed change. It never rebuilds: the graph's `apply`
 * writes ten parameters and one gain, so a slider drag allocates a new config
 * object and nothing else (§28, §30).
 *
 * The graph is engaged only when the EQ is actually ON. A disabled EQ never
 * creates an `AudioContext`, which is what keeps a page load free of audio
 * processing and what §27 asks for.
 */
function push(): void {
  const graph = getEqGraph();
  if (!state.config.enabled || state.comparing) {
    if (graph.isEngaged) {
      graph.bypass();
    }
    return;
  }
  const state42 = effectiveGraphState(state.config);
  void graph.engage(state42).then((ok) => {
    if (ok) {
      setState({ engaged: true, unsupportedReason: null });
      return;
    }
    setState({
      engaged: false,
      unsupportedReason: graph.unsupportedReason,
    });
  });
}

/* ==========================================================================
   ACTIONS
   ========================================================================== */

export interface EqActions {
  setEnabled: (enabled: boolean) => void;
  choosePreset: (presetId: EQPresetId) => void;
  setBandGain: (index: number, gain: number) => void;
  setPreampMode: (mode: "auto" | "manual") => void;
  setManualPreamp: (db: number) => void;
  /** A/B hold (§23). `true` is EQ off, `false` returns to the stored config. */
  setComparing: (comparing: boolean) => void;
  /** Adopts a configuration from outside - a server read or a rollback. */
  hydrate: (config: EQConfig) => void;
  reset: () => void;
  setSaveStatus: (saveStatus: EqSaveStatus) => void;
  setEngaged: (engaged: boolean, reason?: EqUnsupportedReason | null) => void;
}

export const eqActions: EqActions = {
  setEnabled(enabled) {
    if (state.config.enabled === enabled) {
      return;
    }
    const config = { ...state.config, enabled };
    setState({
      config,
      revision: state.revision + 1,
      saveStatus: "idle",
    });
    push();
  },

  choosePreset(presetId) {
    // `isPresetApplied`, not `presetId === presetId`. The model's answer is the
    // one that matters: a document that NAMES a preset without carrying it is
    // the state in which "select Aurora V-Shape" has to do real work, and a
    // short-circuit on the name alone would leave the listener with a curve the
    // interface is mislabelling.
    if (isPresetApplied(state.config, presetId)) {
      return;
    }
    // `selectPreset` replaces bands AND headroom together (§9): an old preset's
    // preamp must not survive the switch.
    const config = selectPreset(presetId);
    setState({
      config,
      revision: state.revision + 1,
      saveStatus: "idle",
    });
    push();
  },

  setBandGain(index, gain) {
    const config = setBandGain(state.config, index, gain);
    if (config === state.config) {
      return;
    }
    setState({
      config,
      revision: state.revision + 1,
      saveStatus: "idle",
    });
    push();
  },

  setPreampMode(mode) {
    if (state.config.preampMode === mode) {
      return;
    }
    // Switching INTO auto re-derives the figure immediately, and switching to
    // manual seeds the slider with whatever is currently in effect so the
    // control does not appear to jump (§38).
    const config: EQConfig = {
      ...state.config,
      preampMode: mode,
      manualPreampDb:
        mode === "manual" ? effectivePreampDb(state.config) : state.config.manualPreampDb,
    };
    setState({ config, revision: state.revision + 1, saveStatus: "idle" });
    push();
  },

  setManualPreamp(db) {
    const manualPreampDb = clampPreampDb(db);
    if (state.config.manualPreampDb === manualPreampDb) {
      return;
    }
    setState({
      config: { ...state.config, manualPreampDb },
      revision: state.revision + 1,
      saveStatus: "idle",
    });
    push();
  },

  setComparing(comparing) {
    if (state.comparing === comparing) {
      return;
    }
    setState({ comparing });
    push();
  },

  hydrate(config) {
    setState({
      config: { ...config, bands: cloneBands(config.bands) },
      revision: state.revision + 1,
    });
    push();
  },

  reset() {
    const config = resetEQ();
    setState({
      config,
      comparing: false,
      revision: state.revision + 1,
      saveStatus: "idle",
    });
    push();
  },

  setSaveStatus(saveStatus) {
    // GUARDED, and the guard is load-bearing rather than tidy. Subscribers of
    // this store write the save status themselves - that is how a write
    // failure becomes visible - and every `setState` notifies every listener.
    // An unguarded assignment therefore re-notifies the very subscriber that
    // made it, forever: an infinite render loop whose only symptom is a
    // spinning tab and a console full of identical warnings. It is easy to
    // introduce and hard to read, because nothing here looks recursive.
    if (state.saveStatus === saveStatus) {
      return;
    }
    setState({ saveStatus });
  },

  setEngaged(engaged, reason = null) {
    if (state.engaged === engaged && state.unsupportedReason === reason) {
      return;
    }
    setState({ engaged, unsupportedReason: reason });
  },
};

/* ==========================================================================
   DERIVED HELPERS FOR THE INTERFACE
   ========================================================================== */

/** A band's index by frequency, for building stable `id`/`htmlFor` pairs. */
export function bandIndexOf(frequency: number): number {
  return EQ_BAND_FREQUENCIES.indexOf(
    frequency as (typeof EQ_BAND_FREQUENCIES)[number],
  );
}

/** The grid the band sliders snap to, so the UI and the model cannot disagree. */
export { quantizeBandGain };
