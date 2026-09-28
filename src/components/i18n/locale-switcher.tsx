"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "./locale-provider";
import { usePresence } from "@/components/ui/presence";
import { LOCALES, LOCALE_NAMES, type Locale } from "@/lib/i18n/locale";
import { CheckIcon } from "@/components/ui/icons";

/**
 * Language selector (Phase 42). Lives in existing shell surfaces —
 * never a top-level destination. Full option names (never bare codes),
 * check-marked selection (never color-alone), keyboard support with
 * focus return, and a stable test hook for E2E.
 */
export function LocaleSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useLocale();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  // Presence (Phase 48). The switcher drifts away from its trigger — down in
  // the header, up in the sidebar — which is why the direction is derived
  // from `compact` rather than hard-coded.
  const { mounted, presenceProps } = usePresence(open);

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open ]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
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
  }, [open ]);

  const choose = (next: Locale) => {
    setOpen(false);
    if (next !== locale) {
      setLocale(next);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("settings.languageLabel")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="locale-switcher"
        onClick={() => setOpen(!open)}
        className={
          compact
            ? "grid h-11 w-11 place-items-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            : "aurora-press aurora-glass-nested flex w-full items-center gap-2 rounded-xl border border-border-subtle px-3 py-2 text-left transition-colors hover:border-accent/50"
        }
      >
        {compact ? (
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" />
          </svg>
        ) : (
          <>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="text-[11px] uppercase tracking-[0.14em] text-text-muted">
                {t("settings.language")}
              </span>
              <span className="truncate text-[13px] font-semibold text-text-primary">
                {LOCALE_NAMES[locale]}
              </span>
            </span>
            <span aria-hidden="true" className="text-text-muted">
              ▾
            </span>
          </>
        )}
      </button>
      {mounted ? (
        <div
          role="menu"
          aria-label={t("settings.languageLabel")}
          {...presenceProps}
          className={`${compact ? "presence-menu" : "presence-menu-up"} aurora-glass-float absolute z-dropdown w-48 overflow-hidden rounded-xl border border-border-subtle ${
            // `left-0`, not `right-0` (Phase 55, responsive QA). The compact
            // trigger lives in the mobile header to the LEFT of the account
            // group, so it is not near the right edge of the viewport. A
            // 192px menu right-aligned to a 44px trigger 96-140px from the
            // left edge (320-360px phones) overflowed the LEFT edge by up to
            // 52px, clipping its border, padding and the selected checkmark.
            // Measured anchor=left across every compact width (320-1023):
            // the menu's right edge lands at triggerX+192, which stays inside
            // the viewport because ≥~150px of controls always follow the
            // trigger. Left overflow adds no width to the document, so the
            // overflow harness never saw it; it is caught by
            // `getBoundingClientRect`.
            compact ? "left-0 top-full mt-1" : "bottom-full mb-1 w-full"
          }`}
        >
          {LOCALES.map((code) => {
            const selected = code === locale;
            return (
              <button
                key={code}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-testid={`locale-option-${code}`}
                onClick={() => choose(code)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-hover focus:bg-surface-hover focus:outline-none"
              >
                <span className="grid h-4 w-4 shrink-0 place-items-center">
                  {selected ? (
                    <CheckIcon size={16} className="text-accent" />
                  ) : null}
                </span>
                <span>{LOCALE_NAMES[code]}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
