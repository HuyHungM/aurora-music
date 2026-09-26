"use client";

import { useMemo, useSyncExternalStore } from "react";
import {
  declaredPreampDb,
  effectiveBands,
  effectivePreampDb,
  getEqState,
  isHeadroomSaturatedFor,
  requiredPreampFor,
  autoPreampFor,
  subscribeEq,
  type EqState,
} from "./eq-store";
import type { EQBand, EQConfig } from "./eq";

/**
 * The React face of the EQ store (Phase 53 addendum, §42).
 *
 * Kept in its own file so `eq-store.ts` stays importable from Node - the
 * persistence logic, the audio graph and the tests all use it without React in
 * scope, and a `useSyncExternalStore` import in the store would make every one
 * of them client-only for no reason. `music/use-music-engine.ts` is the same
 * split for the same reason.
 *
 * WHAT IT DOES NOT DO IS HOLD A COPY. There is no `useState` for the
 * configuration anywhere: every render reads the same module-level object the
 * audio graph is reading. That is what makes a change in Settings appear in the
 * player's control in the same commit with no synchronisation code, because
 * there is only one value to synchronise.
 */
export function useEqState(): EqState {
  return useSyncExternalStore(subscribeEq, getEqState, getEqState);
}

/** What a panel renders, with every derived figure already resolved. */
export interface EqView {
  config: EQConfig;
  /** Bands actually in effect - all 0 dB while bypassed or comparing (§12). */
  bands: EQBand[];
  /** The preamp in effect right now, in dB. */
  preampDb: number;
  /** The preset's declared preamp, for display (§38). */
  declaredPreampDb: number;
  /** What automatic headroom would compute for this curve. */
  autoPreampDb: number;
  /** What automatic headroom would need, before clamping. */
  requiredPreampDb: number;
  /** Whether automatic headroom cannot express its own answer. */
  saturated: boolean;
}

/**
 * The derived snapshot, as a plain function of a configuration.
 *
 * A function rather than a hook so a test can assert what a panel would render
 * without rendering it, and so there is exactly one derivation.
 *
 * Note what this costs when it runs: the headroom figures sweep the composite
 * transfer function, about 512 evaluations of ten biquads. That is a few hundred
 * microseconds, which is invisible once and ruinous at 4 Hz - and a panel that
 * re-rendered on every `timeupdate` would be paying it several times a second.
 * Hence the memo below, keyed on identity that changes only when the
 * configuration actually does.
 */
export function deriveView(config: EQConfig, comparing: boolean): EqView {
  return {
    config,
    bands: effectiveBands(config, comparing),
    preampDb: effectivePreampDb(config, comparing),
    declaredPreampDb: declaredPreampDb(config.presetId),
    autoPreampDb: autoPreampFor(config.bands),
    requiredPreampDb: requiredPreampFor(config.bands),
    saturated: isHeadroomSaturatedFor(config.bands),
  };
}

/**
 * The panel's view, derived once per configuration change.
 *
 * Keyed on `config` and `comparing` rather than on the whole store state,
 * because the store's state object is replaced by every notification -
 * including the save status ticking from "saving" to "saved", which happens
 * while a panel is open. Keying on the state object would therefore re-run the
 * sweep for a status change, which is precisely the "large JS calculation on an
 * unrelated render" §30 rules out. The config object is replaced only by an
 * action that really changed the configuration.
 */
export function useEqView(): EqView {
  const { config, comparing } = useEqState();
  return useMemo(
    () => deriveView(config, comparing),
    [config, comparing],
  );
}
