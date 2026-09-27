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

import { logger } from "@/lib/diagnostics/logger";
import {
  DEFAULT_EQ,
  EQ_BAND_FREQUENCIES,
  autoPreampDb,
  clampPreampDb,
  cloneBands,
  effectiveGraphState,
  headroomSaturated,
  isPresetApplied,
  maxBandGainDb,
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
import { getEqGraph, setEqSourceUnreadableListener, type EqUnsupportedReason } from "./eq-graph";

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
 * The mode currently in effect, in the four canonical names (§3).
 *
 * `flat` | `aurora-v` | `custom` are the shipped presets; `bypass` is what
 * those three become when the equalizer is off or the listener is holding A/B.
 *
 * THIS IS THE ONE AUTHORITY FOR THAT LAST CASE, and it exists so the answer is
 * derived once instead of re-invented. `effectivePreampDb`, `effectiveBands`
 * and `push()` all encode "comparing or not enabled means neutral"; naming the
 * result of that condition makes it a thing that can be logged, asserted and
 * shown, rather than a rule each caller has to remember. Bypass is a derived
 * state and never a stored one - there is no `bypass` flag to disagree with
 * `enabled`, because it is computed from `enabled` at the moment it is asked
 * for.
 */
export type EQMode = EQPresetId | "bypass";

export function effectiveMode(
  config: EQConfig = state.config,
  comparing: boolean = state.comparing,
): EQMode {
  if (comparing || !config.enabled) {
    return "bypass";
  }
  return config.presetId;
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
 * Monotonic id for `push()` (§18).
 *
 * `engage()` is a promise, and a slow attempt raised by an earlier
 * configuration change must not be the one whose `.then` lands last. Without
 * this a stale write could stamp `unsupportedReason` over a successful
 * engagement, leaving the interface reporting an error for a graph that is in
 * fact running - the "UI says one thing, audio says another" state §17
 * forbids. The latest request always wins.
 */
let pushGeneration = 0;

/**
 * The mode logged last, so the health check runs on a MODE TRANSITION and not
 * on every slider event (§23's "lightweight, not per animation frame").
 */
let lastPushedMode: EQMode | null = null;

/** A cheap structural read of the graph, for diagnostics only (§23). */
function logGraphHealth(graph: ReturnType<typeof getEqGraph>): void {
  const health = graph.health();
  logger.info("Equalizer graph health", {
    event: "eq_audio_graph_health",
    engaged: health.engaged,
    audioContextState: health.contextState,
    filterCount: health.filterCount,
    preampConnected: health.preampConnected,
    awaitingGesture: health.awaitingGesture,
    awaitingSource: health.awaitingSource,
    sourceUnreadable: health.sourceUnreadable,
    failure: health.failure,
  });
}

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
  const generation = (pushGeneration += 1);
  const previousMode = lastPushedMode;
  const mode = effectiveMode();
  const modeChanged = mode !== previousMode;
  lastPushedMode = mode;

  if (!state.config.enabled || state.comparing) {
    if (graph.isEngaged) {
      // Neutral through the SAME nodes, never by disconnecting: tearing the
      // path down would be silence, and silence is not bypass (§12).
      graph.bypass();
      logger.info("Equalizer bypassed", {
        event: "eq_bypass_changed",
        mode,
        previousMode,
        bypass: true,
        preamp: 0,
        maxBandGain: 0,
        audioContextState: graph.health().contextState,
      });
    }
    if (modeChanged) {
      logGraphHealth(graph);
    }
    return;
  }

  const state42 = effectiveGraphState(state.config);
  if (modeChanged) {
    logger.info("Equalizer mode change requested", {
      event: "eq_mode_change_requested",
      mode,
      previousMode,
      preamp: roundDb(effectivePreampDb(state.config)),
      maxBandGain: roundDb(maxBandGainDb(state.config.bands)),
      filterCount: graph.nodeCount,
      audioContextState: graph.health().contextState,
    });
  }

  void graph.engage(state42).then((ok) => {
    if (generation !== pushGeneration) {
      return;
    }
    if (ok) {
      // `sourceUnreadableReason` rather than a flat `null`: a graph that is up
      // and applying a curve while the current stream cannot be read is still
      // not doing what the interface is about to claim, and a successful
      // engagement must not wipe that into silence of its own.
      setState({
        engaged: true,
        unsupportedReason: graph.sourceUnreadableReason,
      });
      if (modeChanged) {
        logGraphHealth(graph);
      }
      return;
    }
    if (graph.isAwaitingGesture || graph.isAwaitingSource) {
      // Not an error. The graph is waiting for the browser to allow a context
      // to start, or for the element to have a source worth inspecting, and it
      // re-attempts on its own at the next gesture or the next source.
      // Reporting this as "unsupported" would put an error message in front of
      // a listener whose equalizer is perfectly healthy - and on a page load
      // where nothing can be playing anyway.
      setState({ engaged: false, unsupportedReason: null });
      return;
    }
    setState({
      engaged: false,
      unsupportedReason: graph.unsupportedReason,
    });
  });
}

/** Diagnostics are readable numbers on a log line, not 3.0000000000000004. */
function roundDb(value: number): number {
  return Math.round(value * 100) / 100;
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
    const previousMode = state.config.presetId;
    // `selectPreset` replaces bands AND headroom together (§9): an old preset's
    // preamp must not survive the switch.
    const config = selectPreset(presetId);
    setState({
      config,
      revision: state.revision + 1,
      saveStatus: "idle",
    });
    logger.info("Equalizer preset applied", {
      event: "eq_preset_applied",
      mode: effectiveMode(config, state.comparing),
      previousMode,
      preamp: roundDb(resolvePreampDb(config)),
      maxBandGain: roundDb(maxBandGainDb(config.bands)),
      filterCount: getEqGraph().nodeCount,
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

/**
 * The graph's post-engagement audit, wired to this store's state.
 *
 * WHY IT IS REGISTERED RATHER THAN POLLED. A track change replaces the
 * element's `src` without committing a single equalizer change, so there is no
 * configuration event for this store to notice a new source on. The graph is
 * the only party that hears the element's `loadstart`, and this is the one
 * finding that arrives from there after the fact.
 *
 * WHY IT KEEPS `engaged` TRUE. The graph IS up and IS applying the curve. What
 * it cannot do is process this particular stream, and the interface has to be
 * able to say exactly that - not "the equalizer is unavailable", which would be
 * a different and untrue claim about a running graph.
 */
setEqSourceUnreadableListener(() => {
  if (!state.config.enabled || state.comparing) {
    return;
  }
  eqActions.setEngaged(true, "cors-tainted");
});

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
