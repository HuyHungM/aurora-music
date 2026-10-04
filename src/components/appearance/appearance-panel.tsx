"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AMBIENT_DIRECTION_IDS,
  AMBIENT_MOTION_IDS,
  AMBIENT_PRESET_IDS,
  AMBIENT_TRANSITION_IDS,
  APPEARANCE_RANGES,
  applyAmbientPreset,
  applyPreset,
  isAmbientPresetId,
  MUSIC_REACTIVE_IDS,
  isMusicReactiveId,
  BACKGROUND_PRESET_IDS,
  GLASS_PRESET_IDS,
  withAmbientControl,
  type Appearance,
  type AppearanceControlName,
  type AmbientDirectionId,
  type AmbientMotionId,
  type AmbientTransitionId,
  type GlassPresetId,
} from "@/lib/appearance/appearance";
import {
  BACKGROUND_REJECTION_KEYS,
  validateBackgroundImage,
  type BackgroundImageEnvironment,
} from "@/lib/appearance/background-image";
import { useAppearance } from "./appearance-root";
import { useLocale } from "@/components/i18n/locale-provider";
import { usePresence } from "@/components/ui/presence";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { CheckIcon, ImageIcon, ArrowDownIcon, ArrowUpIcon } from "@/components/ui/icons";

/**
 * The Appearance section (Phase 53, §5, §6, §17, §20-§25, §46-§48, §54, §57-§60).
 *
 * FIVE SECTIONS ARE ALWAYS VISIBLE and the individual controls inside them
 * are behind two disclosures. That split is the product decision the whole
 * feature rests on: a user who opens Settings has one switch, four looks to
 * try, a background, the eight per-control sliders, and the Ambient Light
 * switch — and nothing else. The sliders exist for the person who wants them
 * and are not what a first-time visitor is shown, because a form of twenty
 * controls whose defaults are already good reads as unfinished.
 *
 * EVERY CONTROL IS A NATIVE ELEMENT WHERE ONE EXISTS. The sliders are
 * `input[type=range]`, so keyboard stepping, Home/End, and the correct
 * `slider` role come from the platform rather than from reimplemented
 * handlers. The switch is a `button[role=switch]` with a visible On/Off
 * word, never colour alone. The preset group is a real `radiogroup` with a
 * roving tabindex, so arrow keys move between looks the way a radio group is
 * supposed to - and because the selected preset also shows a check glyph and
 * its name, the state survives greyscale and high contrast.
 *
 * NOTHING HERE DECIDES WHAT A VALUE MEANS. Every control renders from
 * `APPEARANCE_RANGES` and every write goes through `update`, which hands the
 * draft to the one authority in `appearance-root.tsx`. The panel has no
 * appearance state of its own except the URL it is typing, because a second
 * copy of the truth is a second thing to get wrong.
 */
export function AppearancePanel() {
  const { t } = useLocale();
  // Only what THIS component renders. `update`, `setBackground` and
  // `appearance` are read by the sections below, each of which calls
  // `useAppearance()` itself - the sections are separate components so a
  // control re-render stays scoped to the control, and re-subscribing here as
  // well would be a second read of the same authority for no benefit.
  const { status, reason, dirty, reset } = useAppearance();

  return (
    <div className="flex flex-col gap-8">
      {/* --- The switch ------------------------------------------------- */}
      <section aria-labelledby="appearance-glass" className="flex flex-col gap-3">
        <h2 id="appearance-glass" className="t-section-title text-text-primary">
          {t("settings.glassTitle")}
        </h2>
        <p className="t-caption max-w-prose">{t("settings.glassDescription")}</p>
        <GlassSwitch />
      </section>

      {/* --- Presets ---------------------------------------------------- */}
      <section aria-labelledby="appearance-preset" className="flex flex-col gap-3">
        <h2 id="appearance-preset" className="t-section-title text-text-primary">
          {t("settings.presetTitle")}
        </h2>
        <p className="t-caption max-w-prose">{t("settings.presetDescription")}</p>
        <PresetGroup />
      </section>

      {/* --- Background ------------------------------------------------- */}
      <section aria-labelledby="appearance-background" className="flex flex-col gap-3">
        <h2
          id="appearance-background"
          className="t-section-title text-text-primary"
        >
          {t("settings.backgroundTitle")}
        </h2>
        <p className="t-caption max-w-prose">
          {t("settings.backgroundDescription")}
        </p>
        <BackgroundSection />
      </section>

      {/* --- Advanced ----------------------------------------------------
           ABOVE Ambient Light, deliberately. Advanced is the escape hatch for
           tuning the surface system itself; Ambient Light is a feature with its
           own switch and its own disclosure. Putting the closed, collapsed
           Advanced disclosure last meant it sat directly beneath whichever
           section the user had just expanded, so enabling Ambient Light pushed
           an unrelated control out of reach. Advanced now closes the
           always-on settings, and the one opt-in feature follows it. */}
      <section aria-labelledby="appearance-advanced" className="flex flex-col gap-3">
        <AdvancedDisclosure />
        <p id="appearance-advanced" className="sr-only">
          {t("settings.advancedDescription")}
        </p>
      </section>

      {/* --- Ambient Light ------------------------------------------------- */}
      <section aria-labelledby="appearance-ambient" className="flex flex-col gap-3">
        <h2 id="appearance-ambient" className="t-section-title text-text-primary">
          {t("settings.ambient.title")}
        </h2>
        <p className="t-caption max-w-prose">
          {t("settings.ambient.enableDescription")}
        </p>
        <AmbientLightSection />
      </section>

      {/* --- Reset -------------------------------------------------------- */}
      <section className="flex flex-col gap-3 border-t border-border-subtle pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            onClick={reset}
            data-testid="appearance-reset"
          >
            {t("settings.resetAppearance")}
          </Button>
          {/* The save state is announced rather than merely coloured, and it
              is only ever non-empty when there is something true to say - a
              control that announced "saved" after every slider step would be
              noise a screen-reader user has to sit through. */}
          <p
            role="status"
            aria-live="polite"
            className="t-caption min-h-4 text-text-muted"
            data-testid="appearance-status"
          >
            {status === "error" && reason ? t(reason) : null}
            {status === "error" && !reason ? t("settings.saveFailed") : null}
            {status === "saved" && dirty ? t("settings.saving") : null}
          </p>
        </div>
        <p className="t-caption max-w-prose">{t("settings.resetDescription")}</p>
      </section>
    </div>
  );
}

/* ==========================================================================
   THE SWITCH (§17, §38)
   ========================================================================== */

function GlassSwitch() {
  const { t } = useLocale();
  const { appearance, update } = useAppearance();
  const on = appearance.glass;
  return (
    <div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => update({ glass: !on })}
        data-testid="glass-switch"
        className="aurora-press flex w-full max-w-sm items-center gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left transition-colors hover:border-accent/50 aurora-glass-nested"
      >
        <span
          aria-hidden="true"
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            on ? "bg-accent" : "bg-surface-active"
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-accent-foreground transition-transform ${
              on ? "translate-x-5.5" : "translate-x-0.5"
            }`}
          />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="text-sm font-medium text-text-primary">
            {t("settings.glassSwitchLabel")}
          </span>
          <span className="t-caption">{t(on ? "settings.on" : "settings.off")}</span>
        </span>
      </button>
    </div>
  );
}

/* ==========================================================================
   PRESETS (§46)
   ========================================================================== */

function PresetGroup() {
  const { t } = useLocale();
  const { appearance, update } = useAppearance();
  const selected = appearance.preset;
  // Roving tabindex: the group is one tab stop, and the arrow keys move
  // between options. Without this a keyboard user would have to Tab through
  // four stops to change one setting, which is how a radiogroup stops being
  // a radiogroup.
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const move = useCallback(
    (from: number, delta: number) => {
      const nextIndex =
        (from + delta + GLASS_PRESET_IDS.length) % GLASS_PRESET_IDS.length;
      const next = GLASS_PRESET_IDS[nextIndex];
      // A radio group selects as it moves, which is why this is one `update`
      // carrying both the new id and its values.
      update({ preset: next, ...presetPatch(appearance, next) });
      refs.current[next]?.focus();
    },
    [update, appearance],
  );

  return (
    <div
      role="radiogroup"
      aria-label={t("settings.presetTitle")}
      className="grid grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {GLASS_PRESET_IDS.map((id, index) => {
        const active = id === selected;
        return (
          <button
            key={id}
            ref={(node) => {
              refs.current[id] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            data-testid={`preset-${id}`}
            onClick={() => update({ preset: id, ...presetPatch(appearance, id) })}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
            className={`aurora-press aurora-touch flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm transition-colors aurora-glass-nested ${
              active
                ? "border-accent text-text-primary"
                : "border-border-subtle text-text-secondary hover:text-text-primary"
            }`}
          >
            <span className="grid h-4 w-4 shrink-0 place-items-center">
              {active ? <CheckIcon size={16} className="text-accent" /> : null}
            </span>
            <span className="truncate font-medium">{t(`settings.preset.${id}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   BACKGROUND (§4-§8, §12-§14, §61, §62, §63)
   ========================================================================== */

function BackgroundSection() {
  const { t } = useLocale();
  const { appearance, setBackground, reason, backgroundImage } = useAppearance();
  const [url, setUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const fieldId = useId();

  const applied = appearance.background;

  // The preview follows the field while it is being typed and falls back to
  // the applied image otherwise. Derived during render rather than synced in
  // an effect, so there is no frame showing the stale image and no
  // setState-during-effect cascade: the two writers of `preview` (the
  // `onChange` below, and the apply/remove handlers) already clear it
  // whenever they clear the field, so there was no state for an effect to
  // reconcile.
  const shown = preview ?? backgroundImage;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = url.trim();
    if (candidate.length === 0) {
      setBackground({ kind: "none" });
      setUrl("");
      setPreview(undefined);
      setLocalError(undefined);
      return;
    }
    setChecking(true);
    setLocalError(undefined);
    const env: BackgroundImageEnvironment = {
      // No cross-origin `fetch` here. The application's CSP pins `connect-src`
      // to 'self', so a fetch of a user-supplied address could only ever be
      // blocked by the browser and logged as a console violation — it is not a
      // validation production can actually perform. Validation runs on the
      // browser's own decode (below), which needs no CORS: that is the same
      // path a CORS-refusing host already took, so nothing that production
      // could observe is lost.
      // `src` is assigned here, not by the validator: the validator only asks
      // for an element at an address and reads `naturalWidth` off it, so the
      // element has to be constructed already pointed at that address. Setting
      // it after construction would race the `decode()` the validator starts
      // on the next line.
      createImage: (src) => {
        const image = new Image();
        image.src = src;
        return image;
      },
    };
    const result = await validateBackgroundImage(candidate, env);
    setChecking(false);
    if (!result.ok) {
      setLocalError(BACKGROUND_REJECTION_KEYS[result.reason]);
      return;
    }
    // Store the trimmed, re-parsed address the validator returned rather than
    // what was typed, so the persisted value is exactly the one that was
    // checked.
    setBackground({ kind: "url", url: result.info.url });
    setUrl("");
    setPreview(undefined);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Preview. Always rendered, so "what does this look like" has a stable
          place to live and the section does not change height when a
          background is applied. */}
      <div
        className="aurora-glass-edge relative h-40 overflow-hidden rounded-2xl border border-border-subtle"
        data-testid="background-preview"
        data-background={applied.kind}
        style={
          shown && shown !== "none"
            ? {
                backgroundImage: shown,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      >
        {(!shown || shown === "none") && (
          <span className="absolute inset-0 grid place-items-center text-text-muted">
            <ImageIcon size={22} />
          </span>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="t-label">{t("settings.backgroundPresets")}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {BACKGROUND_PRESET_IDS.map((id) => {
            const active =
              applied.kind === "preset" && applied.id === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                data-testid={`background-preset-${id}`}
                onClick={() => setBackground({ kind: "preset", id })}
                className={`aurora-press aurora-touch flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors aurora-glass-nested ${
                  active
                    ? "border-accent text-text-primary"
                    : "border-border-subtle text-text-secondary hover:text-text-primary"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="h-6 w-6 shrink-0 rounded-md border border-border-subtle"
                  style={{
                    backgroundImage: `url("/backgrounds/${id}.svg")`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }}
                />
                <span className="truncate font-medium">
                  {t(`settings.backgroundPreset.${id}`)}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <form onSubmit={submit} className="flex flex-col gap-1.5">
        <label
          htmlFor={fieldId}
          className="text-sm font-medium text-text-primary"
        >
          {t("settings.backgroundUrlLabel")}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={fieldId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              // The typed address previews immediately (§58), but it is NOT
              // applied until it has been validated - a preview is not a
              // promise, and a half-typed address that is already driving the
              // whole application is a bad trade.
              setPreview(
                event.target.value.trim().length === 0
                  ? undefined
                  : `url("${event.target.value.trim().replace(/[\\"]/g, "\\$&")}")`,
              );
              setLocalError(undefined);
            }}
            placeholder={t("settings.backgroundUrlPlaceholder")}
            data-testid="background-url"
            className="h-11 min-w-0 flex-1 select-text rounded-xl border border-border-subtle px-3 text-sm text-text-primary placeholder:text-text-disabled aurora-glass-nested"
          />
          <Button type="submit" disabled={checking} data-testid="background-apply">
            {checking ? t("settings.backgroundChecking") : t("settings.backgroundApply")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setBackground({ kind: "none" });
              setUrl("");
              setPreview(undefined);
              setLocalError(undefined);
            }}
            data-testid="background-remove"
          >
            {t("settings.backgroundRemove")}
          </Button>
        </div>
        <p className="t-caption max-w-prose">{t("settings.backgroundHint")}</p>
      </form>

      {localError || (reason && reason.startsWith("settings.backgroundError.")) ? (
        <p role="alert" className="t-caption text-danger" data-testid="background-error">
          {/* BOTH BRANCHES ARE I18N KEYS, AND BOTH GO THROUGH `t`.
              `localError` is `BACKGROUND_REJECTION_KEYS[reason]` - the same
              shape of value as `reason`, from the same table. Rendering one
              translated and the other raw is the exact mistake that key-based
              error plumbing invites, and it is invisible until somebody pastes
              an `http://` address and reads
              `settings.backgroundError.insecureScheme` on screen. */}
          {t(localError ?? (reason ?? "settings.backgroundError.invalidUrl"))}
        </p>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   AMBIENT LIGHT
   ==========================================================================
   A FIRST-CLASS Appearance setting, not a row buried in Advanced. The reason is
   progressive disclosure in the other direction: the switch is the whole
   feature to somebody who does not want it, and the seven controls are noise to
   the same person. So OFF shows one row, and ON reveals the depth layer.

   The controls reuse the primitives this panel already has rather than
   introducing a second set: `AppearanceSlider` for the numeric ones, and a
   native `<select>` for the enumerated ones. That is deliberate — a settings
   page with two slider styles and two enumerated-control behaviours is worse
   than a slightly long one. The enumerated ones go through the shared `Select`
   precisely so that keyboard support, the mobile picker and the screen-reader
   announcement are the platform's job rather than this file's — see
   `ui/select.tsx` for why the trigger is ours and the popup is not.

   INTENSITY APPEARS TWICE, and that is not an oversight. `--p-appearance-aurora`
   drives the general aurora wash AND the artwork field, so it is genuinely
   shared. It stays in Advanced for the wash and appears here under its own
   label for the artwork field; both write the same value. Removing it from
   Advanced would take away the only control for the wash, which exists
   whether or not Ambient Light is on.
*/

const AMBIENT_SLIDERS: readonly {
  name: AppearanceControlName;
  labelKey: string;
}[] = [
  // `auroraIntensity` is deliberately NOT here: it is always visible, because it
  // is the control that decides how present the effect is.
  { name: "ambientBlur", labelKey: "settings.ambient.blur" },
  { name: "ambientSpread", labelKey: "settings.ambient.spread" },
  { name: "ambientFade", labelKey: "settings.ambient.fade" },
  // Two MULTIPLIERS rather than two more "amount of light" sliders: Intensity
  // already owns how present the effect is, so these say where the light sits —
  // the four screen edges versus the Player itself. At their default of 1 both
  // leave the shipped appearance untouched.
  { name: "ambientEdgeGlow", labelKey: "settings.ambient.edgeGlow" },
  { name: "ambientPlayerGlow", labelKey: "settings.ambient.playerGlow" },
];

const AMBIENT_SEGMENTS: readonly {
  name: "ambientDirection" | "ambientTransition" | "ambientMotion";
  labelKey: string;
  /** Dictionary prefix for this group's option labels — NOT the field name. */
  optionPrefix: "direction" | "transition" | "motion";
  options: readonly string[];
}[] = [
  {
    name: "ambientDirection",
    labelKey: "settings.ambient.direction",
    optionPrefix: "direction",
    options: AMBIENT_DIRECTION_IDS,
  },
  {
    name: "ambientTransition",
    labelKey: "settings.ambient.transition",
    optionPrefix: "transition",
    options: AMBIENT_TRANSITION_IDS,
  },
  {
    name: "ambientMotion",
    labelKey: "settings.ambient.motion",
    optionPrefix: "motion",
    options: AMBIENT_MOTION_IDS,
  },
];

const percent = (value: number): string => `${Math.round(value * 100)}%`;

function AmbientLightSection() {
  const { t } = useLocale();
  const { appearance, update } = useAppearance();
  const [regionId] = useId();
  const switchLabelId = `${regionId}-switch-label`;
  const on = appearance.artworkAmbient;

  return (
    <div className="flex flex-col gap-4" data-testid="appearance-ambient">
      {/* The switch row. The whole feature when OFF.

          `GlassSwitch`'s shape, not a second one: `button[role=switch]` with
          `aria-checked` and a visible On/Off word, so the state survives
          greyscale, high contrast and a screen reader. The checkbox this
          replaced had none of those — it was colour plus a tick — and it was
          the only control in this panel that broke the rule the file's own
          header states.

          The row is a `div` rather than the `<label>` it was because
          `<label for>` cannot name a button, and a `<label>` with no
          labelable control in it names nothing. The title span carries the
          name through `aria-labelledby` instead, so the association survives
          translation the way the selects' `<label for>` does.

          `aurora-touch` is load-bearing here, unlike on `GlassSwitch`. Not
          because the row is smaller — it is the whole row, as that one is —
          but because this row carries only a title, so it does not clear 44px
          on its own. The class is a coarse-pointer-only floor, so the compact
          desktop switch is unchanged.

          THE ROW IS THE BUTTON, which is what `GlassSwitch` does and what this
          control did NOT do when it was a checkbox. Wrapping the checkbox in a
          `<label>` made the whole row a pointer target; the first version of
          this rebuild used a `<div>` beside a small `<button>` and silently
          took that away, leaving most of the row dead to a mouse. The row
          carries the label and the switch together, so it is one control.

          `aria-labelledby` rather than letting the contents name it: the row
          also contains the visible On/Off word, and `GlassSwitch` has that
          same latent problem — a name of "Aurora On" instead of "Aurora". Here
          the word is `aria-hidden` for that reason.

          NO description line here. The section already prints
          `settings.ambient.enableDescription` beneath its heading, so a copy
          inside the row duplicated a 170-character paragraph. */}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={switchLabelId}
        onClick={() => update({ artworkAmbient: !on })}
        data-testid="artwork-ambient"
        className="aurora-touch aurora-press flex max-w-sm items-center justify-between gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left aurora-glass-nested"
      >
        <span
          id={switchLabelId}
          className="text-sm font-medium text-text-primary"
        >
          {t("settings.ambient.enable")}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <span
            aria-hidden="true"
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              on ? "bg-accent" : "bg-surface-active"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-accent-foreground transition-transform ${
                on ? "translate-x-5.5" : "translate-x-0.5"
              }`}
            />
          </span>
          <span className="t-caption" aria-hidden="true">
            {t(on ? "settings.on" : "settings.off")}
          </span>
        </span>
      </button>

      {/* The depth layer, and ONLY when the feature is on. */}
      {on ? (
        <div
          id={regionId}
          role="group"
          aria-label={t("settings.ambient.title")}
          className="flex flex-col gap-5"
          data-testid="appearance-ambient-depth"
        >
          <AmbientSelect
            label={t("settings.ambient.preset")}
            testId="ambient-preset"
            options={AMBIENT_PRESET_IDS}
            selected={appearance.ambientPreset}
            labelFor={(id) => `settings.ambient.preset_${id}`}
            onSelect={(id) => {
              if (!isAmbientPresetId(id)) {
                return;
              }
              update(applyAmbientPreset(appearance, id));
            }}
          />

          {/* Intensity is the one numeric control that stays out of the
              disclosure: it is what makes the effect more or less present, which
              is the thing someone enabling the feature is actually deciding. */}
          <AppearanceSlider
            name="auroraIntensity"
            label={t("settings.ambient.intensity")}
            value={appearance.auroraIntensity}
            format={percent}
            onChange={(value) =>
              update(withAmbientControl(appearance, "auroraIntensity", value))
            }
          />

          <AmbientMoreControls>
            {AMBIENT_SLIDERS.map((control) => (
              <AppearanceSlider
                key={control.name}
                name={control.name}
                label={t(control.labelKey)}
                value={appearance[control.name]}
                format={percent}
                onChange={(value) =>
                  update(withAmbientControl(appearance, control.name, value))
                }
              />
            ))}

            {AMBIENT_SEGMENTS.map((segment) => (
              <AmbientSelect
                key={segment.name}
                label={t(segment.labelKey)}
                testId={`ambient-${segment.name}`}
                options={segment.options}
                selected={appearance[segment.name]}
                labelFor={(id) => `settings.ambient.${segment.optionPrefix}_${id}`}
                onSelect={(id) =>
                  update(
                    withAmbientControl(
                      appearance,
                      segment.name,
                      id as AmbientDirectionId &
                        AmbientTransitionId &
                        AmbientMotionId,
                    ),
                  )
                }
              />
            ))}

            {/* Music reactivity, described in the PRODUCT's language rather than
                the analysis's. Nobody needs to know what an FFT is to decide
                whether the light should breathe with the track. */}
            <AmbientSelect
              label={t("settings.ambient.musicReactive")}
              testId="ambient-musicReactive"
              options={MUSIC_REACTIVE_IDS}
              selected={appearance.ambientMusicReactive}
              labelFor={(id) => `settings.ambient.musicReactive_${id}`}
              onSelect={(id) => {
                if (!isMusicReactiveId(id)) return;
                update({ ambientMusicReactive: id });
              }}
            />
          </AmbientMoreControls>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The chevron on a disclosure, in the app's own icon set rather than as a text
 * glyph.
 *
 * MEASURED, and this is why the `▾`/`▴` characters are gone from both
 * disclosures in this file. Their LAYOUT was never the problem: the glyph's box
 * sat exactly on the button's centre line (0px off in a 42px button). The
 * problem is where the INK sits inside that box — `▾` in Geist has an ink box of
 * 7px above and 2px below the baseline, so its painted centre is 7.5px above
 * the centre of the 20px line box it occupies. The arrow therefore floated high
 * against the label beside it, and no amount of flex alignment could fix it,
 * because the element was already centred.
 *
 * A path has no baseline and no font metrics, so the chevron is centred by
 * construction and renders identically whatever the user's font stack resolves
 * to — which is the whole point, since the previous version's position depended
 * on which font the visitor's browser actually had.
 *
 * `shrink-0` because it is a flex child of a `justify-between` row: without it
 * a long translated label would compress the chevron rather than the label.
 */
function DisclosureChevron({ open }: { open: boolean }) {
  const Icon = open ? ArrowUpIcon : ArrowDownIcon;
  return (
    <Icon
      size={16}
      aria-hidden="true"
      className="shrink-0 text-text-muted"
    />
  );
}

/**
 * The Ambient Light controls that are NOT needed to make the feature work.
 *
 * MEASURED, and this is why it exists. With all seven controls visible, turning
 * Ambient Light on grew the Appearance page by 772px — 169px collapsed, 941px
 * expanded — which made the section visually heavier than every other setting
 * combined and buried the four sections above it. Six of the seven are
 * refinements; one (Intensity) is the decision, and it stays visible.
 *
 * The disclosure reuses the same shape as `AdvancedDisclosure` — a
 * `usePresence` region behind an `aria-expanded` / `aria-controls` button — so
 * the two disclosures in this panel behave identically instead of the page
 * growing two different-looking accordions.
 */
function AmbientMoreControls({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const { mounted, presenceProps } = usePresence(open);
  const regionId = useId();
  const buttonId = `${regionId}-button`;

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        data-testid="ambient-more-toggle"
        className="aurora-press flex w-full max-w-sm items-center justify-between gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left text-sm font-medium text-text-primary transition-colors hover:border-accent/50 aurora-glass-nested"
      >
        {t("settings.ambient.moreControls")}
        <DisclosureChevron open={open} />
      </button>

      {mounted ? (
        <div
          id={regionId}
          role="group"
          aria-labelledby={buttonId}
          {...presenceProps}
          className="flex flex-col gap-5"
          data-testid="appearance-ambient-more"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The enumerated Ambient Light controls, each a named set of choices.
 *
 * A thin wrapper over the shared `Select`. It exists for ONE reason: every one
 * of these controls is a list of STORED IDs (`subtle`, `fast`, `left`) whose
 * DISPLAY is a translated sentence, and that mapping is a decision this file
 * makes rather than the primitive. The primitive takes `value`/`label` pairs,
 * so this is where a value becomes a word.
 *
 * Accessibility is the platform's, and that is the point rather than a
 * compromise — see `ui/select.tsx` for why the popup stays native while the
 * trigger is ours. One tab stop, arrow keys change the value, the label is a
 * real `<label for>`, the option text is what a screen reader reads, and a
 * phone gets the OS picker instead of a listbox.
 */
function AmbientSelect({
  label,
  options,
  selected,
  labelFor,
  testId,
  onSelect,
}: {
  label: string;
  options: readonly string[];
  selected: string;
  labelFor: (id: string) => string;
  testId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useLocale();

  return (
    // The shared primitive, not a second hand-written select. This was the only
    // `<select>` left in the product, and it carried its own trigger class
    // string — so "make every select look the same" was a change in two files
    // that had to agree by hand. `ui/select.tsx` owns the trigger, the chevron,
    // the focus ring, and the right padding that keeps a long label clear of
    // the arrow; this wrapper only translates.
    <Select
      // `max-w-sm` matches the switch row above, so the section keeps ONE
      // measure. A full-width control over three options reads as a form field
      // that expects more than the control can ever contain.
      id={testId}
      label={label}
      value={selected}
      options={options.map((option) => ({
        value: option,
        label: t(labelFor(option)),
      }))}
      onChange={onSelect}
    />
  );
}

/* ==========================================================================
   ADVANCED (§22, §47, §48)
   ========================================================================== */

const ADVANCED_CONTROLS: readonly {
  name: AppearanceControlName;
  labelKey: string;
  format: (value: number) => string;
  /**
   * The control paints the background IMAGE layer, and `globals.css` removes
   * that layer entirely at `data-aurora-background="none"` — one
   * full-viewport `display: none` that every user without a background pays
   * for. So with no background chosen these three have nothing to act on, and
   * leaving them live would be a control that moves and changes nothing.
   */
  imageOnly?: boolean;
}[] = [
  {
    name: "glassAlpha",
    labelKey: "settings.control.glassAlpha",
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    name: "glassBlur",
    labelKey: "settings.control.glassBlur",
    format: (v) => `${v}px`,
  },
  {
    name: "glassSaturation",
    labelKey: "settings.control.glassSaturation",
    format: (v) => `${v.toFixed(2)}×`,
  },
  {
    name: "auroraIntensity",
    labelKey: "settings.control.auroraIntensity",
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    name: "backgroundDim",
    labelKey: "settings.control.backgroundDim",
    format: (v) => `${Math.round(v * 100)}%`,
    imageOnly: true,
  },
  {
    name: "borderIntensity",
    labelKey: "settings.control.borderIntensity",
    format: (v) => `${Math.round(v * 100)}%`,
  },
  {
    name: "backgroundSaturation",
    labelKey: "settings.control.backgroundSaturation",
    format: (v) => `${v.toFixed(2)}×`,
    imageOnly: true,
  },
  {
    name: "backgroundBlur",
    labelKey: "settings.control.backgroundBlur",
    format: (v) => `${v}px`,
    imageOnly: true,
  },
];

function AdvancedDisclosure() {
  const { t } = useLocale();
  const { appearance, update } = useAppearance();
  const [open, setOpen] = useState(false);
  const { mounted, presenceProps } = usePresence(open);
  const regionId = useId();
  const buttonId = `${regionId}-button`;
  const hasBackground = appearance.background.kind !== "none";

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        id={buttonId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen(!open)}
        data-testid="appearance-advanced-toggle"
        className="aurora-press flex w-full max-w-sm items-center justify-between gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left text-sm font-medium text-text-primary transition-colors hover:border-accent/50 aurora-glass-nested"
      >
        {t("settings.advanced")}
        <DisclosureChevron open={open} />
      </button>

      {mounted ? (
        <div
          id={regionId}
          role="region"
          aria-labelledby={buttonId}
          {...presenceProps}
          className="flex flex-col gap-5"
          data-testid="appearance-advanced"
        >
          {ADVANCED_CONTROLS.map((control) => (
            <AppearanceSlider
              key={control.name}
              name={control.name}
              label={t(control.labelKey)}
              value={appearance[control.name]}
              format={control.format}
              disabled={control.imageOnly === true && !hasBackground}
              hint={
                control.imageOnly === true && !hasBackground
                  ? t("settings.control.needsBackground")
                  : undefined
              }
              onChange={(value) => update({ [control.name]: value })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AppearanceSlider({
  name,
  label,
  value,
  format,
  disabled,
  hint,
  onChange,
}: {
  name: AppearanceControlName;
  label: string;
  value: number;
  format: (value: number) => string;
  /** See `ADVANCED_CONTROLS[].imageOnly`: nothing to act on, and said so. */
  disabled?: boolean;
  hint?: string;
  onChange: (value: number) => void;
}) {
  const { t } = useLocale();
  const id = useId();
  const range = APPEARANCE_RANGES[name];
  // The range is expressed as min/max/step rather than as an enumerated list
  // of stops, so the native slider does the stepping. It matters that `step`
  // is the model's own step rather than `any`: a value restored from storage is
  // quantised with that same number, so the handle can never come to rest
  // somewhere the control could not itself produce.
  const description = t("settings.control.rangeHint", {
    min: format(range.min),
    max: format(range.max),
  });

  return (
    <div className="flex max-w-md flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={id}
          className={disabled ? "text-sm font-medium text-text-disabled" : "text-sm font-medium text-text-primary"}
        >
          {label}
        </label>
        <span className="t-utility tabular-nums text-text-muted">{format(value)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        // `aria-valuetext` because a bare "0.62" is meaningless to a screen
        // reader and "62%" is not.
        aria-valuetext={`${format(value)} (${description})`}
        aria-describedby={`${id}-hint`}
        data-testid={`control-${name}`}
        className="h-6 w-full cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      />
      <p id={`${id}-hint`} className="t-caption">
        {hint ?? description}
      </p>
    </div>
  );
}

/* ==========================================================================
   PRESET VALUES
   ========================================================================== */

/**
 * The values a preset writes, as a patch.
 *
 * Computed against the *current* appearance rather than against the default,
 * so choosing a look only overwrites the controls that look actually owns:
 * switching from "Crystal" to "Minimal" must not silently discard the
 * background image, the dimming, or the artwork toggle the user set afterwards.
 * Anything a preset does not name is left exactly as it was.
 *
 * Spreading this into a single `update` is what makes choosing a look ONE
 * change - one debounce, one cookie write, one database mutation - instead of
 * five of each.
 */
function presetPatch(
  current: Appearance,
  id: GlassPresetId,
): Partial<Record<AppearanceControlName, number>> {
  const applied = applyPreset(current, id);
  const patch: Partial<Record<AppearanceControlName, number>> = {};
  for (const name of Object.keys(APPEARANCE_RANGES) as AppearanceControlName[]) {
    if (applied[name] !== current[name]) {
      patch[name] = applied[name];
    }
  }
  return patch;
}
