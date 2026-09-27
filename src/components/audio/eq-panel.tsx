"use client";

import { useId, useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";
import {
  EQ_BAND_GAIN_MAX_DB,
  EQ_BAND_GAIN_MIN_DB,
  EQ_BAND_GAIN_STEP_DB,
  PREAMP_MAX_DB,
  PREAMP_MIN_DB,
  quantizeBandGain,
  type EQBand,
} from "@/lib/audio/eq";
import { eqActions } from "@/lib/audio/eq-store";
import { useEqState, useEqView } from "@/lib/audio/use-eq";
import {
  EQ_CHOICE_IDS,
  bandRegionKey,
  presetDescriptionKey,
  presetLabelKey,
} from "@/lib/audio/eq-labels";

/**
 * The equalizer panel (Phase 53 addendum, §36, §37, §38, §43).
 *
 * WHAT AN ORDINARY LISTENER SEES, and no more: an on/off control, a choice of
 * preset, and a way to compare against the original. Three controls for a
 * feature whose whole value is "it sounds better and I can hear how". The ten
 * bands and the preamp sit behind the same `Advanced` disclosure the appearance
 * panel uses, because a grid of ten sliders is an invitation to break something
 * and no reason to open a preferences page at all.
 *
 * IT READS THE STORE AND WRITES THE STORE. There is no local copy of the
 * configuration, which is what §42 asks for: a change here is a change
 * everywhere, in the same commit, because there is only one value. The single
 * piece of state this component owns is whether the disclosure is open, and that
 * is a property of the component rather than of the equalizer.
 *
 * THE PREAMP IS SHOWN, NOT EDITED, WHILE AUTOMATIC HEADROOM IS ON (§38). A
 * slider sitting on a value the system is about to overrule is worse than no
 * slider: it invites a listener to set something and then be ignored. So the
 * control is a two-state switch, and in the automatic state the figure is
 * labelled as computed rather than presented as something to adjust.
 *
 * ACCESSIBILITY (§43). Every slider is a real `input[type=range]`, so keyboard
 * stepping, Home/End and the browser's own announcements come for free. Each
 * carries `aria-valuetext` with a SIGNED decibel figure and the band's place in
 * the spectrum, because "0.5" is not "+0.5 dB" and a screen-reader user deserves
 * the difference.
 *
 * NO PER-FRAME WORK (§30). A slider's `onChange` calls straight into the store,
 * which pushes parameters at the graph with a 30 ms ramp. There is no animation
 * loop, no analyser, no state update on a timer, and nothing here that runs
 * while music plays except the browser painting a value that changed.
 */
export function EqPanel() {
  const { t } = useLocale();
  const { config, unsupportedReason, saveStatus } = useEqState();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const enabled = config.enabled;

  return (
    <section aria-labelledby="eq-title" className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 id="eq-title" className="text-base font-semibold text-text-primary">
          {t("eq.title")}
        </h2>
        <p className="t-caption max-w-prose">{t("eq.sectionDescription")}</p>
      </header>

      <EqSwitch enabled={enabled} />

      {/*
        The rest is REMOVED while the equalizer is off, not disabled. A disabled
        control is still in the tab order, and a page of controls that do
        nothing is a page nobody trusts. `hidden` also takes them out of the
        accessibility tree, so they are not announced as unavailable.
      */}
      <div hidden={!enabled} className="flex flex-col gap-4">
        <PresetGroup />
        <CompareButton />
        {unsupportedReason ? (
          // §33: the equalizer is not a prerequisite for playback, and this says
          // so in the same breath as the failure. A notice reporting only the
          // problem would read as "music is broken".
          //
          // WHICH notice, though, because the reasons are not the same kind of
          // fact. `cors-tainted` is about this STREAM rather than about this
          // browser, and a listener whose browser is fine deserves to be told
          // that: "this browser cannot process audio" would be a confident and
          // untrue answer to a question they did not ask.
          <p role="status" aria-live="polite" className="t-caption max-w-prose text-warning">
            {unsupportedReason === "cors-tainted"
              ? t("eq.unsupportedSource")
              : t("eq.unsupported")}
          </p>
        ) : null}
        <AdvancedDisclosure open={advancedOpen} onToggle={setAdvancedOpen} />
      </div>

      <div className="flex flex-col items-start gap-2">
        <EqStatus saveStatus={saveStatus} />
        <ResetButton />
      </div>
    </section>
  );
}

/* ==========================================================================
   ON / OFF
   ========================================================================== */

function EqSwitch({ enabled }: { enabled: boolean }) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => eqActions.setEnabled(!enabled)}
      className="aurora-press flex w-full max-w-sm items-center gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left text-sm transition-colors hover:bg-surface-hover"
      data-testid="eq-switch"
    >
      <SwitchTrack on={enabled} />
      {/* A visible word, never colour alone. */}
      <span className="font-medium text-text-primary">
        {enabled ? t("eq.enabled") : t("eq.disabled")}
      </span>
    </button>
  );
}

/** The shared switch graphic, so both switches cannot drift apart. */
function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
        on
          ? "justify-end border-accent bg-accent-muted"
          : "justify-start border-border-subtle bg-surface-2"
      }`}
    >
      <span
        className={`mx-0.5 h-4 w-4 rounded-full transition-colors ${
          on ? "bg-accent" : "bg-text-muted"
        }`}
      />
    </span>
  );
}

/* ==========================================================================
   PRESETS
   ========================================================================== */

function PresetGroup() {
  const { t } = useLocale();
  const view = useEqView();

  return (
    <fieldset className="flex max-w-lg flex-col gap-2">
      <legend className="text-sm font-medium text-text-primary">
        {t("eq.presetLabel")}
      </legend>
      {/*
        A real radio group of real radios, not three buttons. Both reasons are
        about behaviour rather than looks: arrow keys move between options and
        announce the new selection, and assistive technology reports "3 of 3"
        instead of leaving a listener to count buttons. The appearance panel's
        preset group works the same way, for the same reasons.
      */}
      <div
        role="radiogroup"
        aria-label={t("eq.presetLabel")}
        className="flex flex-col gap-2"
      >
        {EQ_CHOICE_IDS.map((id) => {
          const isActive = view.config.presetId === id;
          return (
            <label
              key={id}
              className={`aurora-press flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                isActive
                  ? "border-accent bg-accent-muted/50"
                  : "border-border-subtle hover:bg-surface-hover"
              }`}
            >
              <input
                type="radio"
                name="eq-preset"
                value={id}
                checked={isActive}
                onChange={() => eqActions.choosePreset(id)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
                data-testid={`eq-preset-${id}`}
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium text-text-primary">
                  {t(presetLabelKey(id))}
                </span>
                <span className="t-caption">
                  {t(presetDescriptionKey(id))}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {/*
        §38: with Aurora V-Shape selected, the declared preamp is a fact, not a
        control. It is the preset's specified figure and does not move with the
        curve, which is exactly why it belongs here as a label while the manual
        slider lives in the disclosure.
      */}
      <p className="t-caption tabular-nums" data-testid="eq-declared-preamp">
        {t("eq.preamp")}: {formatDb(t, view.declaredPreampDb)}
      </p>
    </fieldset>
  );
}

/* ==========================================================================
   A/B COMPARISON
   ========================================================================== */

function CompareButton() {
  const { t } = useLocale();
  const { comparing } = useEqState();

  return (
    <button
      type="button"
      aria-pressed={comparing}
      // Hold to compare. `onPointerUp`/`onPointerLeave` rather than a toggle,
      // because §23 asks for a comparison and a comparison is a state you are
      // IN, not a mode you enter - and holding the original against the curve is
      // how anybody actually A/Bs anything.
      onPointerDown={() => eqActions.setComparing(true)}
      onPointerUp={() => eqActions.setComparing(false)}
      onPointerLeave={() => eqActions.setComparing(false)}
      onKeyDown={(event) => {
        // §23 needs a keyboard route to the same comparison. Space and Enter
        // "hold" it for as long as they are down.
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          eqActions.setComparing(true);
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          eqActions.setComparing(false);
        }
      }}
      // Leaving the button by any other route must not strand the comparison
      // on, which would leave a listener hearing the original and wondering why.
      onBlur={() => eqActions.setComparing(false)}
      className="aurora-press flex w-full max-w-sm items-center gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left text-sm transition-colors hover:bg-surface-hover"
      data-testid="eq-compare"
    >
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-text-primary">
          {comparing ? t("eq.comparing") : t("eq.compare")}
        </span>
        <span className="t-caption">{t("eq.compareHint")}</span>
      </span>
    </button>
  );
}

/* ==========================================================================
   STATUS AND RESET
   ========================================================================== */

function EqStatus({
  saveStatus,
}: {
  saveStatus: "idle" | "saving" | "saved" | "failed";
}) {
  const { t } = useLocale();
  if (saveStatus === "saving") {
    return (
      <p role="status" aria-live="polite" className="t-caption">
        {t("eq.saving")}
      </p>
    );
  }
  if (saveStatus === "failed") {
    return (
      <p role="status" aria-live="polite" className="t-caption text-danger">
        {t("eq.saveFailed")}
      </p>
    );
  }
  if (saveStatus === "saved") {
    // Visually quiet; a screen reader still hears it, which is the entire reason
    // for putting it in a live region.
    return (
      <p role="status" aria-live="polite" className="t-caption text-text-muted">
        {t("eq.applied")}
      </p>
    );
  }
  return null;
}

function ResetButton() {
  const { t } = useLocale();
  return (
    <button
      type="button"
      onClick={() => eqActions.reset()}
      // `aurora-press` alone: measured 135x42 on every phone and tablet
      // width. `py-2.5` plus a 20px line lands 2px under the 44px floor, and
      // this is the one destructive-ish EQ action, so it is the last control
      // that should be a near-miss. `aurora-touch` (Phase 54).
      className="aurora-press aurora-touch rounded-xl border border-border-subtle px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover"
      data-testid="eq-reset"
    >
      {t("eq.reset")}
    </button>
  );
}

/* ==========================================================================
   ADVANCED
   ========================================================================== */

function AdvancedDisclosure({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const { t } = useLocale();
  const buttonId = useId();
  const regionId = `${buttonId}-region`;

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => onToggle(!open)}
        className="aurora-press flex w-full max-w-sm items-center justify-between gap-3 rounded-xl border border-border-subtle px-4 py-3 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover"
        data-testid="eq-advanced-toggle"
      >
        {t("settings.advanced")}
        <span aria-hidden="true" className="text-text-muted">
          {open ? "−" : "+"}
        </span>
      </button>
      <div
        id={regionId}
        role="region"
        aria-labelledby={buttonId}
        hidden={!open}
        className="flex flex-col gap-4"
      >
        <BandSliders />
        <PreampControl />
      </div>
    </div>
  );
}

function BandSliders() {
  const { t } = useLocale();
  const { bands } = useEqView();

  return (
    <div className="flex flex-col gap-3" data-testid="eq-bands">
      {bands.map((band, index) => (
        <BandSlider
          key={band.frequency}
          band={band}
          index={index}
          name={t(bandRegionKey(band.frequency))}
        />
      ))}
    </div>
  );
}

function BandSlider({
  band,
  index,
  name,
}: {
  band: EQBand;
  index: number;
  name: string;
}) {
  const { t } = useLocale();
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className="flex max-w-md flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-text-primary">
          {name}
        </label>
        {/* Both the frequency and the signed gain, so the number is never the
            only thing a listener is told. */}
        <span className="t-utility tabular-nums text-text-muted">
          {t("eq.hz", { frequency: band.frequency })}
          <span aria-hidden="true"> · </span>
          {formatDb(t, band.gain)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={EQ_BAND_GAIN_MIN_DB}
        max={EQ_BAND_GAIN_MAX_DB}
        // The model's own step, not `any`: a value restored from storage is
        // quantised with the same number, so a handle can never come to rest
        // somewhere this control could not itself produce.
        step={EQ_BAND_GAIN_STEP_DB}
        value={quantizeBandGain(band.gain)}
        onChange={(event) =>
          eqActions.setBandGain(index, Number(event.target.value))
        }
        // §43: a signed decibel figure plus the band's place in the spectrum,
        // because "0.5" is not "+0.5 dB".
        aria-valuetext={`${formatDb(t, band.gain)} — ${t("eq.bandLabelHz", {
          name,
          frequency: band.frequency,
        })}`}
        aria-describedby={hintId}
        data-testid={`eq-band-${band.frequency}`}
        className="h-6 w-full cursor-pointer accent-[var(--accent)]"
      />
      <p id={hintId} className="sr-only">
        {t("eq.bandLabelHz", { name, frequency: band.frequency })}
      </p>
    </div>
  );
}

function PreampControl() {
  const { t } = useLocale();
  const view = useEqView();
  const auto = view.config.preampMode === "auto";

  return (
    <div className="flex max-w-md flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-text-primary">
          {t("eq.preamp")}
        </span>
        <span
          className="t-utility tabular-nums text-text-muted"
          data-testid="eq-preamp-value"
        >
          {auto
            ? `${t("eq.preampAutoOn")} · ${formatDb(t, view.preampDb)}`
            : formatDb(t, view.config.manualPreampDb)}
        </span>
      </div>

      {/*
        A switch, because the listener's decision is "shall Aurora work this out,
        or shall I?" and there are two answers. A checkbox with a slider beside
        it would imply the slider is always in charge, and in the automatic state
        it is not.
      */}
      <button
        type="button"
        role="switch"
        aria-checked={auto}
        onClick={() => eqActions.setPreampMode(auto ? "manual" : "auto")}
        className="aurora-press flex w-full items-center gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left text-sm transition-colors hover:bg-surface-hover"
        data-testid="eq-preamp-auto"
      >
        <SwitchTrack on={auto} />
        <span className="font-medium text-text-primary">
          {auto ? t("eq.preampAuto") : t("eq.preampAutoOff")}
        </span>
      </button>

      {/*
        The manual slider exists only in manual mode. Rendering it always and
        disabling it would put a control in the tab order that does nothing,
        which is worse than not having it.
      */}
      {auto ? (
        <>
          <p className="t-caption max-w-prose">{t("eq.preampAutoDescription")}</p>
          {view.saturated ? (
            <p className="t-caption max-w-prose text-warning" data-testid="eq-saturated">
              {t("eq.preampSaturated")}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <input
            type="range"
            aria-label={t("eq.preamp")}
            min={PREAMP_MIN_DB}
            max={PREAMP_MAX_DB}
            step={0.5}
            value={view.config.manualPreampDb}
            onChange={(event) =>
              eqActions.setManualPreamp(Number(event.target.value))
            }
            aria-valuetext={formatDb(t, view.config.manualPreampDb)}
            data-testid="eq-preamp-slider"
            className="h-6 w-full cursor-pointer accent-[var(--accent)]"
          />
          <p className="t-caption max-w-prose">{t("eq.preampDescription")}</p>
        </>
      )}
    </div>
  );
}

/* ==========================================================================
   FORMATTING
   ========================================================================== */

/**
 * A signed decibel figure, through the runtime's own number formatting.
 *
 * The sign is always shown, including at zero. "+0.0 dB" and "0.0 dB" are the
 * same audio, but the sign is what lets a listener see at a glance which bands
 * are cuts and which are boosts, and an unsigned zero makes them guess.
 *
 * A negative zero is normalised first, because `-0.0` from `Intl` reads as a
 * bug in a numeric readout and appears whenever a value rounds to zero from
 * below.
 */
function formatDb(
  t: (key: string, values?: Record<string, string | number>) => string,
  value: number,
): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const formatted = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(rounded);
  return t("eq.db", { value: formatted });
}
