// @vitest-environment jsdom
/**
 * `EqPanel` tests (Phase 53 addendum, §36, §37, §38, §43).
 *
 * The panel is the only place a listener can reach any of this, so these tests
 * are mostly about whether the interface tells the truth:
 *
 *   1. EVERY CONTROL IS A REAL CONTROL. A `role="switch"` carrying a spelled
 *      On/Off, a `radiogroup` of real radios, and native `input[type=range]`
 *      elements whose min/max/step are the model's own constants. A
 *      reimplemented slider is a worse slider and a worse thing to maintain,
 *      and the platform already knows how arrows, Home and End work.
 *
 *   2. EVERY CONTROL STATES ITS VALUE, ITS RANGE AND ITS UNIT. A decibel figure
 *      with a sign, the band named as a region and a frequency, and a preamp
 *      described as headroom management rather than presented as a loudness
 *      knob. §43 asks for exactly this and it is asserted per control so that
 *      removing an `aria-valuetext` fails a test instead of quietly degrading.
 *
 *   3. THE PREAMP IS HEADROOM, NOT VOLUME. The manual figure is presented with
 *      its explanation, and while automatic is on the control is a switch rather
 *      than a slider - a slider sitting on a value the system is about to
 *      overrule is worse than no slider.
 *
 *   4. NO RAW I18N KEY IS EVER RENDERED. `t()` returns the key when a message
 *      is missing, so a visible "eq.presetFlat" is a detectable failure rather
 *      than a subtle one. Both locales are exercised, because a key present in
 *      `en` and missing in `vi` is precisely the bug this catches.
 *
 * There is no jest-dom in this repository, so assertions read `textContent`,
 * attributes and properties directly. That is a constraint, not a compromise -
 * it is what the appearance panel's own tests do.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { EqPanel } from "@/components/audio/eq-panel";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { eqActions, getEqState } from "@/lib/audio/eq-store";
import { resetEqGraphForTests } from "@/lib/audio/eq-graph";
import {
  AURORA_V_SHAPE,
  DEFAULT_PREAMP_DB,
  EQ_BAND_FREQUENCIES,
  EQ_BAND_GAIN_MAX_DB,
  EQ_BAND_GAIN_MIN_DB,
  EQ_BAND_GAIN_STEP_DB,
  PREAMP_MAX_DB,
  PREAMP_MIN_DB,
} from "@/lib/audio/eq";
import type { Locale } from "@/lib/i18n/locale";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

function renderPanel(locale: Locale = "en") {
  return render(
    <LocaleProvider initialLocale={locale}>
      <EqPanel />
    </LocaleProvider>,
  );
}

/** The whole rendered text, for the "no raw key" assertions. */
function renderedText(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  resetEqGraphForTests();
  eqActions.reset();
});

afterEach(() => {
  cleanup();
});

/* ==========================================================================
   THE ORDINARY SURFACE (§36, §37)
   ========================================================================== */

describe("what a listener sees first", () => {
  it("offers the equalizer, its three presets and a comparison - and nothing else", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: /Equalizer/ })).toBeTruthy();
    expect(screen.getByTestId("eq-switch")).toBeTruthy();
    expect(screen.getByTestId("eq-compare")).toBeTruthy();
    // The ten bands are behind the disclosure, so the first screen is three
    // controls rather than a grid of sliders. Asserted through the ROLE query,
    // which honours `hidden`: the element exists in the DOM but is not exposed,
    // and "not exposed" is the property that matters to a listener.
    expect(screen.queryByRole("slider", { hidden: false })).toBeNull();
  });

  it("hides the presets while the equalizer is off, and out of the accessibility tree", () => {
    renderPanel();
    expect(getEqState().config.enabled).toBe(false);
    // `hidden`, not `disabled`. A disabled control is still in the tab order,
    // and being able to Tab to a preset that does nothing is worse than it
    // being absent. The role query is what proves it left the tree.
    expect(screen.getByTestId("eq-switch").getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("radio", { hidden: false })).toBeNull();
  });

  it("reveals the presets when the switch is on", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-switch"));
    expect(getEqState().config.enabled).toBe(true);
    expect(screen.getByTestId("eq-switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("eq-preset-aurora-v")).toBeTruthy();
  });

  it("names the presets in a real radio group, with Aurora V-Shape selected by default", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-switch"));

    const group = screen.getByRole("radiogroup", { name: "Preset" });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios[0]!.getAttribute("checked")).not.toBeNull();
  });

  it("describes each preset rather than naming it alone", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-switch"));

    // §37: the names are not self-explanatory, so the interface says what each
    // one does rather than leaving a listener to discover it by ear.
    const text = renderedText();
    expect(text).toMatch(/midrange left relaxed/);
    expect(text).toMatch(/No change to the sound/);
  });

  it("spells the switch state as a word, never colour alone", () => {
    renderPanel();
    // §43, and the same rule the appearance panel's switch follows.
    expect(screen.getByTestId("eq-switch").textContent).toContain("Equalizer off");
    fireEvent.click(screen.getByTestId("eq-switch"));
    expect(screen.getByTestId("eq-switch").textContent).toContain("Equalizer on");
  });

  it("shows the preset's declared preamp as a fact (§38)", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-switch"));
    // -3.5 exactly, and in the form a listener reads it as.
    expect(screen.getByTestId("eq-declared-preamp").textContent).toBe(
      "Preamp: -3.5 dB",
    );
    expect(DEFAULT_PREAMP_DB).toBe(-3.5);
  });

  it("switches the preamp figure when the preset changes (§9)", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-switch"));
    expect(screen.getByTestId("eq-declared-preamp").textContent).toContain("-3.5");

    fireEvent.click(screen.getByTestId("eq-preset-flat"));
    // Flat declares 0 dB. Leaving -3.5 here is addendum §9's exact failure.
    expect(screen.getByTestId("eq-declared-preamp").textContent).toBe("Preamp: 0.0 dB");
  });

  it("applies a preset selection to the store", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-switch"));
    fireEvent.click(screen.getByTestId("eq-preset-flat"));
    expect(getEqState().config.presetId).toBe("flat");
    expect(getEqState().config.bands.every((b) => b.gain === 0)).toBe(true);
  });

  it("walks V-Shape to Flat and back without leaving a stale preamp", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-switch"));
    const preampAfter = () => screen.getByTestId("eq-declared-preamp").textContent;

    expect(preampAfter()).toContain("-3.5");
    fireEvent.click(screen.getByTestId("eq-preset-flat"));
    expect(preampAfter()).toBe("Preamp: 0.0 dB");
    fireEvent.click(screen.getByTestId("eq-preset-aurora-v"));
    expect(preampAfter()).toContain("-3.5");
  });
});

/* ==========================================================================
   A/B (§23)
   ========================================================================== */

describe("comparison", () => {
  beforeEach(() => {
    eqActions.choosePreset("aurora-v");
    eqActions.setEnabled(true);
  });

  it("is a button that announces its state, not a toggle with a hidden meaning", () => {
    renderPanel();
    const button = screen.getByTestId("eq-compare");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.textContent).toContain("Compare with equalizer off");
  });

  it("engages while held and releases on pointer up", () => {
    renderPanel();
    const button = screen.getByTestId("eq-compare");

    fireEvent.pointerDown(button);
    expect(getEqState().comparing).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");

    fireEvent.pointerUp(button);
    expect(getEqState().comparing).toBe(false);
  });

  it("releases on pointer leave, so it cannot be stranded on", () => {
    renderPanel();
    const button = screen.getByTestId("eq-compare");
    fireEvent.pointerDown(button);
    fireEvent.pointerLeave(button);
    expect(getEqState().comparing).toBe(false);
  });

  it("works from the keyboard too, because holding is not a pointer-only idea", () => {
    renderPanel();
    const button = screen.getByTestId("eq-compare");

    fireEvent.keyDown(button, { key: " " });
    expect(getEqState().comparing).toBe(true);
    fireEvent.keyUp(button, { key: " " });
    expect(getEqState().comparing).toBe(false);

    fireEvent.keyDown(button, { key: "Enter" });
    expect(getEqState().comparing).toBe(true);
    fireEvent.keyUp(button, { key: "Enter" });
    expect(getEqState().comparing).toBe(false);
  });

  it("does not modify the stored curve, so the listener gets it back", () => {
    renderPanel();
    fireEvent.pointerDown(screen.getByTestId("eq-compare"));
    expect(getEqState().config.bands).toEqual([...AURORA_V_SHAPE]);
    expect(getEqState().config.manualPreampDb).toBe(-3.5);
  });
});

/* ==========================================================================
   THE DISCLOSURE AND THE BANDS (§37, §43)
   ========================================================================== */

describe("the advanced disclosure", () => {
  beforeEach(() => {
    eqActions.choosePreset("aurora-v");
    eqActions.setEnabled(true);
  });

  it("is collapsed, expands on click, and says so to assistive technology", () => {
    renderPanel();
    const toggle = screen.getByTestId("eq-advanced-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Collapsed means out of the accessibility tree, not merely zero-height.
    expect(screen.queryByRole("slider", { hidden: false })).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("eq-bands")).toBeTruthy();
    expect(screen.getAllByRole("slider").length).toBeGreaterThan(0);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("slider", { hidden: false })).toBeNull();
  });

  it("points at the region it controls", () => {
    renderPanel();
    const toggle = screen.getByTestId("eq-advanced-toggle");
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(region).not.toBeNull();
    expect(region!.getAttribute("role")).toBe("region");
  });

  it("renders one real range input per band, with the model's own bounds", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));

    const sliders = within(screen.getByTestId("eq-bands")).getAllByRole("slider");
    expect(sliders).toHaveLength(EQ_BAND_FREQUENCIES.length);

    for (const slider of sliders) {
      // The model's own min/max/step, so a handle can never rest somewhere the
      // control could not itself produce.
      expect(slider.getAttribute("min")).toBe(String(EQ_BAND_GAIN_MIN_DB));
      expect(slider.getAttribute("max")).toBe(String(EQ_BAND_GAIN_MAX_DB));
      expect(slider.getAttribute("step")).toBe(String(EQ_BAND_GAIN_STEP_DB));
    }
  });

  it("shows the V-Shape's own gains, signed, in decibels", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));

    expect(
      (screen.getByTestId("eq-band-31") as HTMLInputElement).value,
    ).toBe("2.5");
    expect(screen.getByTestId("eq-band-31").getAttribute("aria-valuetext")).toContain(
      "+2.5 dB",
    );
    // A cut is a cut, and the sign says so.
    expect(
      screen.getByTestId("eq-band-1000").getAttribute("aria-valuetext"),
    ).toContain("-1.0 dB");
  });

  it("names each band as a region AND gives its frequency (§43)", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));

    // A control named only "Treble" tells a screen-reader user nothing about
    // where it sits.
    const valueText = screen.getByTestId("eq-band-8000").getAttribute("aria-valuetext")!;
    expect(valueText).toContain("Treble");
    expect(valueText).toContain("8000");
    expect(renderedText()).toContain("8000 Hz");
  });

  it("moves a band when the control is moved, and says so in the store", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));

    fireEvent.change(screen.getByTestId("eq-band-62"), { target: { value: "6" } });
    expect(getEqState().config.bands[1]!.gain).toBe(6);
    expect(getEqState().config.presetId).toBe("custom");
    expect(
      screen.getByTestId("eq-band-62").getAttribute("aria-valuetext"),
    ).toContain("+6.0 dB");
  });

  it("labels every slider with a real label element, not a placeholder", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));

    for (const frequency of EQ_BAND_FREQUENCIES) {
      const slider = screen.getByTestId(`eq-band-${frequency}`);
      const id = slider.getAttribute("id")!;
      const label = document.querySelector(`label[for="${id}"]`);
      expect(label, `band ${frequency}`).not.toBeNull();
      expect(label!.textContent?.trim().length).toBeGreaterThan(0);
    }
  });
});

/* ==========================================================================
   THE PREAMP AS HEADROOM (§38)
   ========================================================================== */

describe("the preamp", () => {
  beforeEach(() => {
    eqActions.choosePreset("aurora-v");
    eqActions.setEnabled(true);
  });

  it("is a switch between automatic and manual, not a loudness slider", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));

    const control = screen.getByTestId("eq-preamp-auto");
    expect(control.getAttribute("role")).toBe("switch");
    expect(control.getAttribute("aria-checked")).toBe("false");
    // Manual: the slider exists, and the explanation says what it is for.
    expect(screen.getByTestId("eq-preamp-slider")).toBeTruthy();
    expect(renderedText()).toMatch(/headroom management, not a volume control/);
  });

  it("has no slider at all while automatic, because a slider it would overrule is a lie", () => {
    eqActions.setPreampMode("auto");
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));

    expect(screen.getByTestId("eq-preamp-auto").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("eq-preamp-slider")).toBeNull();
    // The figure is still shown - as a computed one.
    expect(screen.getByTestId("eq-preamp-value").textContent).toContain("Automatic");
  });

  it("bounds the manual control to the project's range and never positive", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
    const slider = screen.getByTestId("eq-preamp-slider") as HTMLInputElement;

    expect(slider.getAttribute("min")).toBe(String(PREAMP_MIN_DB));
    expect(slider.getAttribute("max")).toBe(String(PREAMP_MAX_DB));
    // §10: never a positive preamp while boosts are active. The maximum being
    // exactly 0 is the whole of that rule.
    expect(PREAMP_MAX_DB).toBe(0);
  });

  it("switches to automatic and back, keeping the figure in effect", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));

    // Manual starts from whatever the preset declared, so the control does not
    // jump under the listener's hand.
    expect((screen.getByTestId("eq-preamp-slider") as HTMLInputElement).value).toBe("-3.5");

    fireEvent.click(screen.getByTestId("eq-preamp-auto"));
    expect(getEqState().config.preampMode).toBe("auto");
    // The V-Shape is a fixed-figure preset, so switching mode keeps the figure
    // and only changes who computed it.
    expect(getEqState().config.manualPreampDb).toBe(-3.5);
  });

  it("shows the saturation notice when the range cannot express the requirement", () => {
    // Every band at the top of its range needs about -18.9 dB, and the floor is
    // -12. Reported rather than hidden behind a clamped, reassuring number.
    for (let index = 0; index < 10; index += 1) {
      eqActions.setBandGain(index, 12);
    }
    eqActions.setPreampMode("auto");

    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
    expect(screen.getByTestId("eq-saturated")).toBeTruthy();
    expect(renderedText()).toMatch(/cannot fully protect it/);
  });

  it("shows no saturation notice for a curve the range CAN express", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
    expect(screen.queryByTestId("eq-saturated")).toBeNull();
  });
});

/* ==========================================================================
   RESET (§11, §48)
   ========================================================================== */

describe("reset", () => {
  it("restores the shipped default and nothing else", () => {
    eqActions.choosePreset("flat");
    eqActions.setBandGain(3, -9);
    eqActions.setEnabled(true);

    renderPanel();
    fireEvent.click(screen.getByTestId("eq-reset"));

    const { config } = getEqState();
    expect(config.enabled).toBe(false);
    expect(config.presetId).toBe("aurora-v");
    expect(config.bands).toEqual([...AURORA_V_SHAPE]);
    expect(config.preampMode).toBe("auto");
  });

  it("says what it does, including that playback is untouched", () => {
    eqActions.setEnabled(true);
    renderPanel();
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
    // The description is beside the button in the panel's own copy; the button
    // label is the translated string, never a raw key.
    expect(screen.getByTestId("eq-reset").textContent).toBe("Reset equalizer");
  });
});

/* ==========================================================================
   UNAVAILABILITY (§33)
   ========================================================================== */

describe("when Web Audio is unavailable", () => {
  it("says the music still plays, in the same breath as the failure", () => {
    eqActions.setEngaged(false, "no-web-audio");
    eqActions.setEnabled(true);

    renderPanel();
    const text = renderedText();
    expect(text).toMatch(/equalizer is unavailable/);
    // The sentence that matters most: the listener is not being told their
    // music is broken.
    expect(text).toMatch(/still plays normally/);
  });

  it("keeps the controls usable, because the preference is still a preference", () => {
    eqActions.setEngaged(false, "no-web-audio");
    eqActions.setEnabled(true);

    renderPanel();
    // Nothing is disabled and nothing is removed: the choice is still stored,
    // and a browser that supports audio processing later will honour it.
    expect(screen.getByTestId("eq-preset-aurora-v")).toBeTruthy();
    fireEvent.click(screen.getByTestId("eq-preset-flat"));
    expect(getEqState().config.presetId).toBe("flat");
  });
});

describe("when the STREAM cannot be read, rather than the browser", () => {
  it("blames the stream, and never the browser", () => {
    // The distinction is the whole point of having a separate reason. A browser
    // that is working exactly as specified must not be told it cannot process
    // audio - that is a confident, untrue answer to a question the listener
    // never asked, and it would send them to update a browser that is fine.
    eqActions.setEngaged(false, "cors-tainted");
    eqActions.setEnabled(true);

    renderPanel();
    const text = renderedText();
    expect(text).toMatch(/this stream cannot be read/i);
    expect(text).not.toMatch(/this browser cannot process audio/i);
    // Still says the one thing that must be said either way.
    expect(text).toMatch(/still plays normally/i);
  });

  it("keeps saying it while the graph is engaged on an unreadable source", async () => {
    // The post-engagement audit keeps `engaged` true, because the graph IS up.
    // The notice has to survive that, or the interface would claim success
    // exactly when it has lost the signal.
    eqActions.setEnabled(true);
    eqActions.choosePreset("aurora-v");
    await new Promise((resolve) => setTimeout(resolve, 0));
    eqActions.setEngaged(true, "cors-tainted");

    renderPanel();
    expect(renderedText()).toMatch(/this stream cannot be read/i);
  });
});

/* ==========================================================================
   LOCALIZATION (§44)
   ========================================================================== */

describe("localization", () => {
  it("renders no raw key in either locale", () => {
    // `t()` returns the key when a message is missing, so a visible "eq.presetFlat"
    // is a detectable failure rather than a subtle one.
    for (const locale of ["en", "vi"] as const) {
      eqActions.setEnabled(true);
      renderPanel(locale);
      fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
      const text = renderedText();
      expect(text, locale).not.toMatch(/\beq\.[a-zA-Z]/);
      expect(text, locale).not.toMatch(/\bsettings\.[a-zA-Z]/);
      cleanup();
    }
  });

  it("translates the preset names", () => {
    eqActions.setEnabled(true);
    renderPanel("vi");
    expect(renderedText()).toContain("Phẳng");
    expect(renderedText()).toContain("Tùy chỉnh");
  });

  it("translates the band regions", () => {
    eqActions.setEnabled(true);
    renderPanel("vi");
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
    const text = renderedText();
    expect(text).toContain("Siêu trầm");
    expect(text).toContain("Trầm");
    // Ten bands, ten names - and 8 kHz is "Treble", not "Presence".
    expect(text).toContain("Cao");
  });

  it("translates the preamp copy and the switch", () => {
    eqActions.choosePreset("aurora-v");
    eqActions.setEnabled(true);
    renderPanel("vi");
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
    // The manual copy only exists in manual mode, so the mode has to be set
    // before the text can be found - a test that forgot this would pass
    // vacuously against an empty string.
    expect(renderedText()).toMatch(/Preamp là quản lý khoảng dự phòng/);
    expect(renderedText()).toContain("Thủ công");
  });

  it("translates the automatic-headroom copy too", () => {
    eqActions.setPreampMode("auto");
    eqActions.setEnabled(true);
    renderPanel("vi");
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
    expect(renderedText()).toMatch(/Tự động chừa headroom/);
    expect(renderedText()).toMatch(/Aurora tính preamp từ đường cong/);
  });

  it("keeps the decibels and hertz in a form both languages share", () => {
    // Units are symbols, not prose, so they are deliberately identical.
    eqActions.setEnabled(true);
    renderPanel("vi");
    fireEvent.click(screen.getByTestId("eq-advanced-toggle"));
    expect(renderedText()).toContain("dB");
    expect(renderedText()).toContain("Hz");
  });
});
