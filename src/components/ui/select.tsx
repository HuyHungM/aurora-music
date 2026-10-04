"use client";

import { useId, type ReactNode } from "react";
import { ArrowDownIcon } from "@/components/ui/icons";

/**
 * The one select control (§32.11 — "Every control is a native element where
 * one exists", applied to the enumerated settings menus).
 *
 * WHY THIS IS A SHARED PRIMITIVE AND NOT A CLASS STRING PER CALL SITE. Every
 * setting menu in the product that offers a closed set of choices wants the
 * same thing — a 44px control, a quiet border, a hairline chevron, and a label
 * that is a real `<label for>`. Writing that at each site means the chevron's
 * right inset, the right padding that clears it, and the focus treatment are
 * four separate decisions that will drift. Here they are made once.
 *
 * WHY IT IS STILL A NATIVE `<select>`, and this is the load-bearing decision.
 *
 * The popup is drawn by the OPERATING SYSTEM, not by us, so its appearance
 * cannot be styled by any web technology. Every "custom select" in the product
 * that replaces it therefore buys a prettier open menu by giving up:
 *
 *   - the mobile picker, which is better than any listbox on iOS and Android
 *     (a wheel, with the platform's own type-ahead and dismissal);
 *   - the announcement a screen reader makes, which for a native select names
 *     the control, its value, and its position in the set;
 *   - type-ahead, Enter-to-select, Escape, Tab, and click-outside, which the
 *     platform implements correctly on every engine and that a hand-rolled
 *     version reimplements approximately.
 *
 * `appearance: none` is what makes the CLOSED control ours while leaving the
 * OPEN control the platform's. That is the whole trade: a trigger that matches
 * the glass, over a popup that matches the platform. Nothing else in the
 * component is a compromise — the trigger is a real element with real states,
 * not a styled `<div>` pretending to be a control.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No custom listbox, no floating surface,
 * no focus trap, no positioning logic. A select is not a dialog: it needs
 * nothing from the layer stack, nothing from `presence.tsx`, and nothing from
 * `menu-placement.ts`, all three of which exist for surfaces that really are
 * floating layers. Adding them here would be the same second-implementation
 * problem `AmbientSelect`'s own docstring used to argue against.
 */
export interface SelectOption {
  /** The stored value. Stable, machine-facing, never shown. */
  readonly value: string;
  /** The visible, translated label. */
  readonly label: string;
}

export interface SelectProps {
  /**
   * Unique per rendered instance. It is the `<label for>` target AND the
   * `data-testid` stem, so a label that is visible, a label that is announced
   * and a locator a test uses are the same string.
   */
  id: string;
  /** Visible label, already translated by the caller. */
  label: string;
  /** The stored value. */
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /**
   * Rendered under the control, and it must SAY WHY when disabled: a control
   * that is greyed out with no explanation reads as broken rather than as
   * inapplicable, which is the same reason the image-only Advanced sliders say
   * so.
   */
  hint?: ReactNode;
  disabled?: boolean;
  /** Caps the width. Defaults to the section measure its callers already use. */
  className?: string;
}

/**
 * The label and the hint share a column so a long hint cannot change the
 * control's width — the whole block is one flex child with `min-w-0`, and the
 * control is `w-full` inside it, so the column is as wide as its container
 * allows and the trigger always fills it.
 */
export function Select({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
  className,
}: SelectProps) {
  const hintId = useId();

  return (
    <div className={`min-w-0 ${className ?? "max-w-sm"}`} data-testid={`${id}-group`}>
      {/* `font-medium text-text-primary`, which is the settings panel's LABEL
          vocabulary rather than a preference of this component. The two
          disclosure buttons, the two switch rows and every `AppearanceSlider`
          label with 14px medium in `--fg-primary`, at 6px from their control
          (`mb-1.5` here, `gap-1.5` there). A settings form with two label
          treatments reads as two different products stitched together. */}
      <label
        htmlFor={id}
        className="mb-1.5 block text-sm font-medium text-text-primary"
      >
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          data-testid={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          // `appearance-none` removes the platform's OWN arrow; the one below is
          // the app's. Without it both are drawn, and the native one sits on
          // top in Chromium.
          //
          // `pr-10` is what keeps the selected label clear of that arrow. The
          // platform arrow occupies the right inset, and with `appearance: none`
          // nothing reserves the space — so a long value ("Immersive") runs
          // straight under the chevron. The padding is the reservation.
          //
          // `h-11` AND `py-0` together, deliberately: `py-2` on a `text-sm`
          // input is 38px measured, which is under the 40–44px band every
          // other control in the panel occupies and under the touch floor a
          // pointer device is held to anyway. Height is stated once rather than
          // left to padding + line-height, because that sum is what made the
          // control a different size from the disclosure directly above it.
          //
          // The focus treatment is the search field's, unchanged and
          // deliberately: no local `focus:outline-none`, so the app-wide
          // `:focus-visible` outline in `globals.css` applies and carries the
          // indicator. `focus:border-accent` stays as a complementary solid
          // accent, but focus visibility may not depend on a border becoming
          // luminous (§32.11). `cursor-pointer` is here because the platform
          // does not give a `<select>` a pointer cursor in every engine, and a
          // control that looks pressable but not pointable is the
          // inconsistency.
          //
          // NO `bg-*` ON THE TRIGGER. `[data-aurora-glass="on"]
          // .aurora-glass-nested` already sets `background-color` at (0,2,0) —
          // above any Tailwind utility — so a `bg-surface-elevated` here is
          // inert in Glass Mode and, worse, makes this the ONLY filled control
          // in the panel once Glass is off. Every neighbour here is
          // border-and-nested-glass with no explicit fill; this now is too.
          // The popup's own background is the `<option>` below, which is a
          // different problem and a different declaration.
          className="aurora-touch h-11 w-full min-w-0 cursor-pointer appearance-none rounded-xl border border-border-subtle py-0 pl-3 pr-10 text-sm text-text-primary aurora-glass-nested transition-colors hover:border-accent/50 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
          aria-describedby={hint ? hintId : undefined}
        >
          {options.map((option) => (
            // `bg-surface-elevated` on the option, not the trigger's own
            // translucent fill: a native popup inherits the option's
            // background, and a translucent option over whatever the popup
            // paints behind it is unreadable in dark mode.
            <option
              key={option.value}
              value={option.value}
              data-testid={`${id}-${option.value}`}
              className="bg-surface-elevated text-text-primary"
            >
              {option.label}
            </option>
          ))}
        </select>
        {/*
          The chevron, positioned over the space `pr-10` reserved.

          `aria-hidden` because the `<select>` already announces its value, and
          a second glyph would be read out as content the control does not
          contain. `pointer-events-none` because it is decoration sitting over
          the control's own click target: without it a click on the arrow would
          land on the span, and the platform would not open the popup. This is
          the same reason every icon in `icons.tsx` carries the property, but it
          is restated here because here it is load-bearing rather than tidy.
        */}
        <ArrowDownIcon
          size={16}
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
        />
      </div>
      {hint ? (
        <p id={hintId} className="t-caption mt-1.5">
          {hint}
        </p>
      ) : null}
    </div>
  );
}