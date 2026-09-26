/**
 * Band naming (Phase 53 addendum, §44).
 *
 * A small module with one job, so the tests are small too - but the job it
 * does is the kind that fails SILENTLY. The first version of
 * `bandRegionKey` threshold-guessed a region and produced eight names for ten
 * bands, which meant two bands answered to the same label. Nothing threw, no
 * test failed, and the interface was simply wrong: a listener told to pull
 * "Treble" up would find that two handles moved.
 *
 * So the properties asserted here are not "the names are right" - that is a
 * judgement, made once in `eq-labels.ts` and not re-litigated here. They are
 * "the mapping is total, injective, and derived from the model", which are the
 * three ways this can break again.
 */

import { describe, expect, it } from "vitest";
import {
  BAND_REGION_KEYS,
  EQ_CHOICE_IDS,
  bandRegionKey,
  presetDescriptionKey,
  presetLabelKey,
} from "@/lib/audio/eq-labels";
import { EQ_BAND_FREQUENCIES } from "@/lib/audio/eq";
import { getDictionaries, type MessageKey } from "@/lib/i18n/translate";

describe("band naming", () => {
  it("gives every band a name", () => {
    expect(BAND_REGION_KEYS).toHaveLength(EQ_BAND_FREQUENCIES.length);
  });

  it("gives every band a DISTINCT name", () => {
    // The bug this file exists for. A duplicate label is two handles answering
    // to one instruction, and it is invisible to every other kind of test.
    const unique = new Set(BAND_REGION_KEYS);
    expect(unique.size).toBe(BAND_REGION_KEYS.length);
  });

  it("is derived from the model, so adding a band cannot leave this behind", () => {
    // Every band's name comes from its own frequency, not from a parallel list
    // keyed by position. A frequency the model does not have still resolves to
    // a real key rather than `undefined`, which `t()` would render as the
    // literal string "eq.unknown".
    for (const frequency of EQ_BAND_FREQUENCIES) {
      expect(bandRegionKey(frequency)).toMatch(/^eq\.[a-zA-Z]+$/);
    }
    // Off the ends, too.
    expect(bandRegionKey(20)).toMatch(/^eq\.[a-zA-Z]+$/);
    expect(bandRegionKey(20_000)).toMatch(/^eq\.[a-zA-Z]+$/);
    expect(bandRegionKey(0)).toMatch(/^eq\.[a-zA-Z]+$/);
    expect(bandRegionKey(1e9)).toMatch(/^eq\.[a-zA-Z]+$/);
  });

  it("has a real message for every name, in every locale", () => {
    // A key that exists in `en` and not in `vi` is the failure the parity test
    // catches for hand-written keys and the interface shows for derived ones:
    // `t()` returns the key, so the label reads "eq.subBass".
    for (const dictionary of Object.values(getDictionaries())) {
      for (const key of BAND_REGION_KEYS) {
        expect(
          (dictionary as Record<string, unknown>)[
            key.split(".")[0] as string
          ],
          key,
        ).toBeDefined();
      }
    }
  });
});

describe("preset naming", () => {
  it("has a name and a description for every offered preset", () => {
    for (const id of EQ_CHOICE_IDS) {
      expect(presetLabelKey(id)).toMatch(/^eq\.preset/);
      expect(presetDescriptionKey(id)).toMatch(/^eq\.preset.*Description$/);
    }
  });

  it("offers the same three presets the model defines", () => {
    // The list the interface renders is not a second hand-maintained list. If a
    // fourth preset is added to the model this assertion is the thing that has
    // to be updated, which is the correct time to think about its label.
    expect([...EQ_CHOICE_IDS]).toEqual(["aurora-v", "flat", "custom"]);
  });

  it("resolves every key it names in both locales", () => {
    const keys: MessageKey[] = [
      ...BAND_REGION_KEYS,
      ...EQ_CHOICE_IDS.map(presetLabelKey),
      ...EQ_CHOICE_IDS.map(presetDescriptionKey),
    ];
    for (const key of keys) {
      for (const [locale, dictionary] of Object.entries(getDictionaries())) {
        let current: unknown = dictionary;
        for (const part of key.split(".")) {
          current =
            current === null || typeof current !== "object"
              ? undefined
              : (current as Record<string, unknown>)[part];
        }
        expect(current, `${key} in ${locale}`).toBeTypeOf("string");
      }
    }
  });
});
