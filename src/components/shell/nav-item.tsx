"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems, isActivePath } from "./nav-config";
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
  const isBottom = orientation === "bottom";

  return (
    <nav aria-label="Main navigation">
      <ul
        className={
          isBottom
            ? "flex w-full items-stretch"
            : "flex flex-col gap-1"
        }
      >
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
                    ? `flex min-h-12 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                        active ? "text-accent" : "text-text-muted hover:text-text-secondary"
                      }`
                    : `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        active
                          ? "bg-surface-2 text-text-primary"
                          : "text-text-secondary hover:bg-surface-2/60 hover:text-text-primary"
                      }`
                }
              >
                <Icon size={isBottom ? 22 : 20} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}