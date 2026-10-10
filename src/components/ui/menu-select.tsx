"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CheckIcon } from "@/components/ui/icons";
import { usePresence } from "@/components/ui/presence";

/**
 * The one shadcn-style select (§32.11 — "Every control is a native element
 * where one exists", applied through the trigger vocabulary every neighbour
 * already uses).
 *
 * WHAT shadcn-STYLE MEANS HERE. The closed control is a button and the open
 * one is a menu: the trigger carries the label's value and a chevron, and the
 * menu lists every option with a check mark on the current one. The popup is
 * OURS — positioned by the same `presence-menu` layer the track menus use —
 * so it matches the panel rather than the operating system. That is the whole
 * trade, stated once: a trigger and a menu that look like the rest of the
 * product, in exchange for the platform's own picker, announcement and
 * type-ahead, which a button over a menu cannot have.
 *
 * WHAT IS REUSED, NOT REINVENTED. The lifecycle is `usePresence` (enter/exit
 * with the rapid-toggle guarantee, `onExited` for the focus return). Menu rows
 * are `menuitemradio` with `aria-checked`. Outside dismiss is the container
 * `mousedown` check `LocaleSwitcher` uses, Escape closes, and focus returns
 * to the trigger. Arrow keys move focus between rows the way
 * `TrackActionMenu` does. The chevron is the app's own icon set, `aria-hidden`
 * and `pointer-events-none`, because it sits over the trigger's own click
 * target — the same reason every icon in `icons.tsx` carries the property.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No `menu-placement.ts`: the menu opens
 * below its trigger, always, because a settings control has no scroll
 * container to be clipped by and no player bar to land under — that hook
 * exists for row menus, and dragging it here would be the second
 * implementation of a geometric rule this file does not need.
 */

export interface MenuSelectOption {
  /** The stored value. Stable, machine-facing, never shown. */
  readonly value: string;
  /** The visible, translated label. */
  readonly label: string;
}

export interface MenuSelectProps {
  /**
   * Unique per rendered instance. It is the `data-testid` stem and the menu's
   * accessible name source, so the locator a test uses and the name a screen
   * reader hears are the same string.
   */
  id: string;
  /** Visible label, already translated by the caller. */
  label: string;
  /** The stored value. */
  value: string;
  options: readonly MenuSelectOption[];
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
 * trigger always fills it.
 */
export function MenuSelect({
  id,
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
  className,
}: MenuSelectProps) {
  const hintId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  // Presence, not a bare conditional: the open region animates both ways, and
  // `onExited` is where focus returns to the trigger.
  const { mounted, presenceProps } = usePresence(open, {
    onExited: () => {
      triggerRef.current?.focus();
    },
  });

  // The value the trigger shows. Options are a closed set the caller owns, so
  // an unknown value renders as itself rather than as a blank the user cannot
  // explain.
  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? value;

  const choose = (next: string) => {
    setOpen(false);
    if (next !== value) {
      onChange(next);
    }
  };

  // Focus the selected row when the menu appears, so ArrowDown from the
  // trigger is not the only way in: the value itself is the entry point, the
  // same way a native select opens on its current option.
  useEffect(() => {
    if (!open || disabled) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const active = container.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-checked="true"]',
    );
    active?.focus();
  }, [open, disabled]);

  useEffect(() => {
    if (wasOpenRef.current === open) {
      return;
    }
    wasOpenRef.current = open;
    if (open) {
      return;
    }
    // Closed without the presence exit (a choice, which unmounts through
    // `open` itself): focus still returns, on the same tick the surface
    // leaves, because the trigger is where the next Tab expects to land.
    triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || disabled) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      // The container owns the trigger: a `mousedown` that STARTS inside it
      // is the toggle working, not an outsider to dismiss for. Without this
      // the trigger's own `onClick` opens and this document listener closes
      // in the same gesture, and the menu can never open (or reopens then
      // dies).
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, disabled]);

  const focusItem = (direction: 1 | -1) => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    if (items.length === 0) {
      return;
    }
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    // From the trigger (-1) Down enters at the first row; from a row it moves.
    const next =
      current === -1
        ? direction === 1
          ? 0
          : items.length - 1
        : (current + direction + items.length) % items.length;
    items[next]?.focus();
  };

  const handleTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
      }
    }
  };

  const handleItemKeyDown = (event: React.KeyboardEvent, optionValue: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(optionValue);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      containerRef.current
        ?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[0]
        ?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const items = containerRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      );
      items?.[items.length - 1]?.focus();
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative min-w-0 ${className ?? "max-w-sm"}`}
      data-testid={`${id}-group`}
    >
      {/* `font-medium text-text-primary` is the settings panel's LABEL
          vocabulary — the same one `Select`, the two disclosure buttons, the
          switch rows and every `AppearanceSlider` label use, at the same 6px
          gap (`mb-1.5`) so the form keeps one label treatment. */}
      <span
        id={`${id}-label`}
        className="mb-1.5 block text-sm font-medium text-text-primary"
      >
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        data-testid={id}
        aria-labelledby={`${id}-label`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={handleTriggerKeyDown}
        aria-describedby={hint ? hintId : undefined}
        // The trigger treatment is `Select`'s, unchanged: the same label
        // vocabulary, the same 44px height (`h-11`, stated not summed), the
        // same quiet border, the same right padding reserving the chevron's
        // room, the same focus outline left to `globals.css`. A settings form
        // with two trigger treatments reads as two different products
        // stitched together.
        //
        // NO `bg-*`: `[data-aurora-glass="on"] .aurora-glass-nested` already
        // sets `background-color` above any Tailwind utility, and every
        // neighbour is border-and-nested-glass with no explicit fill.
        //
        // `w-full text-left`: the row is the button, so the whole measure is
        // the target and the value reads where a form value is expected.
        className="aurora-touch flex h-11 w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-xl border border-border-subtle py-0 pl-3 pr-10 text-left text-sm text-text-primary aurora-glass-nested transition-colors hover:border-accent/50 focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
        {/*
          The chevron, positioned over the space `pr-10` reserved.

          `aria-hidden` because the button already names its value, and a
          second glyph would be read out as content the control does not
          contain. `pointer-events-none` because it is decoration sitting over
          the control's own click target: without it a click on the arrow would
          land on the span, and the toggle would not run. Same property, same
          reason, as `Select`'s.
        */}
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute right-3 top-1/2 shrink-0 -translate-y-1/2 text-text-muted"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {mounted ? (
        <div
          role="menu"
          aria-labelledby={`${id}-label`}
          {...presenceProps}
          // The surface treatment is the track menus', not the trigger's: the
          // same float, the same border, the same 48px width every other menu
          // in the product chose, the same item rhythm (`px-3 py-2.5`).
          className="presence-menu aurora-glass-float absolute left-0 top-full z-dropdown mt-1 w-48 overflow-hidden rounded-xl border border-border-subtle"
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                data-testid={`${id}-${option.value}`}
                onClick={() => choose(option.value)}
                onKeyDown={(event) => handleItemKeyDown(event, option.value)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-hover focus:bg-surface-hover focus:outline-none active:bg-surface-active"
              >
                {/* The check column, always rendered: the rows align whether or
                    not one of them is checked, so the labels never shift when
                    the value changes. */}
                <span className="grid h-4 w-4 shrink-0 place-items-center">
                  {isSelected ? <CheckIcon size={16} className="text-accent" /> : null}
                </span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {hint ? (
        <p id={hintId} className="t-caption mt-1.5">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
