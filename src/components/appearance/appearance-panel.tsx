"use client";

import {
  useCallback,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  APPEARANCE_RANGES,
  applyPreset,
  BACKGROUND_PRESET_IDS,
  GLASS_PRESET_IDS,
  type Appearance,
  type AppearanceControlName,
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
import { CheckIcon, ImageIcon } from "@/components/ui/icons";

/**
 * The Appearance section (Phase 53, §5, §6, §17, §20-§25, §46-§48, §54, §57-§60).
 *
 * FOUR CONTROLS ARE ALWAYS VISIBLE and everything else is behind a
 * disclosure. That split is the product decision the whole feature rests on:
 * a user who opens Settings has one switch, four looks to try, and a
 * background. The eight individual sliders exist for the person who wants
 * them and are not what a first-time visitor is shown, because a form of ten
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

      {/* --- Advanced ---------------------------------------------------- */}
      <section aria-labelledby="appearance-advanced" className="flex flex-col gap-3">
        <AdvancedDisclosure />
        <p id="appearance-advanced" className="sr-only">
          {t("settings.advancedDescription")}
        </p>
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
      // Delegated rather than reimplemented, so the real network stack is what
      // validates the address. The injected `init` carries `mode: "cors"` and
      // `credentials: "omit"`, and passing it through is what makes the second
      // of those true in practice rather than merely intended.
      fetch: (input, init) => fetch(input, init),
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

      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor={fieldId} className="t-label">
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
   ADVANCED (§22, §47, §48)
   ========================================================================== */

const ADVANCED_CONTROLS: readonly {
  name: AppearanceControlName;
  labelKey: string;
  format: (value: number) => string;
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
  },
  {
    name: "backgroundBlur",
    labelKey: "settings.control.backgroundBlur",
    format: (v) => `${v}px`,
  },
];

function AdvancedDisclosure() {
  const { t } = useLocale();
  const { appearance, update } = useAppearance();
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
        data-testid="appearance-advanced-toggle"
        className="aurora-press flex w-full max-w-sm items-center justify-between gap-3 rounded-xl border border-border-subtle px-4 py-3 text-left text-sm font-medium text-text-primary transition-colors hover:border-accent/50 aurora-glass-nested"
      >
        {t("settings.advanced")}
        <span aria-hidden="true" className="text-text-muted">
          {open ? "▴" : "▾"}
        </span>
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
              onChange={(value) => update({ [control.name]: value })}
            />
          ))}

          <label className="flex max-w-sm cursor-pointer items-center justify-between gap-3 rounded-xl border border-border-subtle px-4 py-3 aurora-glass-nested">
            <span className="flex min-w-0 flex-col leading-tight">
              <span className="text-sm font-medium text-text-primary">
                {t("settings.control.artworkAmbient")}
              </span>
              <span className="t-caption">
                {t("settings.control.artworkAmbientDescription")}
              </span>
            </span>
            <input
              type="checkbox"
              checked={appearance.artworkAmbient}
              onChange={(event) => update({ artworkAmbient: event.target.checked })}
              data-testid="artwork-ambient"
              className="h-5 w-5 shrink-0 accent-[var(--accent)]"
            />
          </label>
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
  onChange,
}: {
  name: AppearanceControlName;
  label: string;
  value: number;
  format: (value: number) => string;
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
        <label htmlFor={id} className="text-sm font-medium text-text-primary">
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
        onChange={(event) => onChange(Number(event.target.value))}
        // `aria-valuetext` because a bare "0.62" is meaningless to a screen
        // reader and "62%" is not.
        aria-valuetext={`${format(value)} (${description})`}
        aria-describedby={`${id}-hint`}
        data-testid={`control-${name}`}
        className="h-6 w-full cursor-pointer accent-[var(--accent)]"
      />
      <p id={`${id}-hint`} className="t-caption">
        {description}
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
