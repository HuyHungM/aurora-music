/**
 * Band naming (Phase 53 addendum, §44).
 *
 * ONE MAPPING, and it is derived rather than written out. A hand-written list of
 * ten frequency-to-name pairs is a list that can fall out of step with
 * `EQ_BAND_FREQUENCIES` in a way nothing would catch: add an eleventh band to the
 * model and this file would still have ten entries, the panel would render nine
 * sliders with one unlabelled, and every existing test would pass. Deriving it
 * from the model means the set of names is total over the set of bands by
 * construction, and `eq-labels.test.ts` asserts it.
 *
 * WHY REGION NAMES AND NOT FREQUENCIES. "31 Hz" is a number; "Treble" is a
 * place in a mix, and it is the place a listener is actually trying to hear. A
 * control labelled with a frequency is a control labelled with its
 * implementation. The frequency is not discarded - `bandLabelHz` puts both in
 * the accessible name, and the visible readout shows the number too - so nothing
 * is hidden, it is just not the headline.
 *
 * TEN NAMES FOR TEN BANDS. A first version threshold-guessed the region and
 * produced eight names, which meant two bands were called "Bass" and a
 * translation key was never used at all - and, worse, the docstring described
 * boundaries the code did not implement. A duplicated name is not a small
 * cosmetic problem: a listener told to pull "Treble" up and then finding that
 * 4 kHz also answered to it has been given a control with two handles. The
 * mapping is therefore positional and total, so every band has exactly one name
 * by construction.
 *
 * THE NAMES ARE THE ONES A LISTENER ALREADY HAS. Sub, bass, low-bass, low-mid,
 * mid, upper-mid, presence, upper-presence, treble, air: the naming a ten-band
 * graphic equalizer has used for decades, because it is how people describe
 * where a problem is ("the vocals are thin" is an upper-mid complaint).
 */

import { EQ_BAND_FREQUENCIES } from "./eq";

/** The translation key naming a band's region of the spectrum. */
export type BandRegionKey =
  | "eq.sub"
  | "eq.bass"
  | "eq.lowBass"
  | "eq.lowMid"
  | "eq.mid"
  | "eq.upperMid"
  | "eq.presence"
  | "eq.upperPresence"
  | "eq.treble"
  | "eq.air";

/**
 * One name per band, in band order.
 *
 * A tuple rather than a lookup table so that the type system refuses a name
 * list of the wrong length: adding an eleventh band to the model is a type
 * error here, not a band that silently renders with somebody else's name.
 */
const BAND_REGION_KEYS_BY_INDEX: readonly BandRegionKey[] = [
  "eq.sub",
  "eq.bass",
  "eq.lowBass",
  "eq.lowMid",
  "eq.mid",
  "eq.upperMid",
  "eq.presence",
  "eq.upperPresence",
  "eq.treble",
  "eq.air",
];

/**
 * Region for one band centre, as a translation key.
 *
 * Total over `EQ_BAND_FREQUENCIES` by construction. An unexpected frequency -
 * one the model does not have a band for - takes the name of the nearest band
 * below it, so a caller can never receive `undefined`, which `t()` would render
 * as the literal string "eq.unknown" - a visible bug in the interface rather
 * than a missing one.
 */
export function bandRegionKey(frequency: number): BandRegionKey {
  const index = EQ_BAND_FREQUENCIES.indexOf(
    frequency as (typeof EQ_BAND_FREQUENCIES)[number],
  );
  if (index >= 0) {
    return BAND_REGION_KEYS_BY_INDEX[index]!;
  }
  let nearest = 0;
  for (let i = 0; i < EQ_BAND_FREQUENCIES.length; i += 1) {
    if (EQ_BAND_FREQUENCIES[i]! <= frequency) {
      nearest = i;
    }
  }
  return BAND_REGION_KEYS_BY_INDEX[nearest]!;
}

/**
 * Every band's region key, in band order.
 *
 * Exported so a test can assert totality - that the mapping covers the model
 * exactly, one name per band - rather than trusting that it does.
 */
export const BAND_REGION_KEYS: readonly BandRegionKey[] =
  EQ_BAND_FREQUENCIES.map(bandRegionKey);

/**
 * The presets offered in the interface, in the order they are offered.
 *
 * `custom` is included deliberately: it is a place a listener can reach (by
 * moving any band), and hiding it from the list would make the interface lie
 * about which curve is active once they had done that.
 */
export const EQ_CHOICE_IDS = ["aurora-v", "flat", "custom"] as const;

export type EQChoiceId = (typeof EQ_CHOICE_IDS)[number];

/** The i18n key naming a preset, and the one describing it. */
export function presetLabelKey(id: EQChoiceId): string {
  if (id === "aurora-v") {
    return "eq.presetAuroraV";
  }
  if (id === "flat") {
    return "eq.presetFlat";
  }
  return "eq.presetCustom";
}

export function presetDescriptionKey(id: EQChoiceId): string {
  if (id === "aurora-v") {
    return "eq.presetAuroraVDescription";
  }
  if (id === "flat") {
    return "eq.presetFlatDescription";
  }
  return "eq.presetCustomDescription";
}
