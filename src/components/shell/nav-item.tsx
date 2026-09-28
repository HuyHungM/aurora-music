"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems, isActivePath } from "./nav-config";
import { useLocale } from "@/components/i18n/locale-provider";
import {
  HomeIcon,
  LibraryIcon,
  RadioIcon,
  SearchIcon,
} from "@/components/ui/icons";
import type { ComponentType } from "react";

const icons: Record<string, ComponentType<{ size?: number; className?: string }>> = {
  home: HomeIcon,
  search: SearchIcon,
  library: LibraryIcon,
  radio: RadioIcon,
};

export function NavList({
  orientation,
  onNavigate,
}: {
  orientation: "sidebar" | "bottom";
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const { t } = useLocale();
  const isBottom = orientation === "bottom";

  // Phase 54: this used to render its own `<nav aria-label>`, which meant
  // the bottom rail produced TWO nested navigation landmarks with the SAME
  // accessible name (and the sidebar a third). A landmark is how a screen
  // reader user jumps between regions, so duplicate names make that jump
  // ambiguous. The landmark now belongs to the caller that owns the
  // container - `app-shell.tsx` for the bottom rail, `sidebar.tsx` for the
  // desktop column - and this component is just the list inside it.
  return (
    <ul className={isBottom ? "flex w-full items-stretch" : "flex flex-col gap-1"}>
      {navItems.map((item) => {
        const Icon = icons[item.icon];
        const active = isActivePath(pathname, item.href);
        return (
          <li key={item.href} className={isBottom ? "flex-1" : undefined}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={
                isBottom
                  ? `relative flex min-h-12 select-none flex-col items-center justify-center gap-1 px-2 text-[11px] font-medium transition-colors ${
                      active ? "text-accent" : "text-text-muted hover:text-text-secondary"
                    }`
                  // `aurora-touch` on the sidebar branch only (Phase 54).
                  // Measured 40px tall on a touch-emulated 1024x1366 tablet:
                  // `py-2.5` plus a 20px line is a mouse-sized target, and
                  // an iPad at 1024 renders this exact layout with a coarse
                  // pointer and no keyboard. The bottom-nav branch below
                  // already declares `min-h-12` (48px) and needed nothing.
                  : `group relative flex aurora-touch select-none items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "bg-accent/12 text-accent"
                        : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                    }`
              }
            >
              {active && !isBottom ? (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-accent"
                />
              ) : null}
              {active && isBottom ? (
                <span
                  aria-hidden="true"
                  className="absolute top-0 h-0.5 w-8 rounded-full bg-accent"
                />
              ) : null}
              <Icon size={isBottom ? 22 : 20} aria-hidden="true" />
              <span className={isBottom ? "" : active ? "font-semibold" : undefined}>
                {t(item.labelKey)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
