"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/i18n/locale-provider";
import { SlidersHorizontalIcon } from "@/components/ui/icons";

/**
 * The one control that routes to Settings (Phase 53).
 *
 * Rendered in the sidebar footer on desktop and in the header below `lg` —
 * and it is ONE component so the copies cannot drift. The sidebar is
 * `hidden lg:flex`, so below `lg` a header copy is the only way to reach
 * Appearance, and a feature nobody can reach is not a feature.
 *
 * The header copy owns ONE slot across every width below `lg`: the compact
 * link, because Settings is the route that already hosts the full language
 * switcher, so no preference becomes unreachable. From `lg` up the sidebar
 * exists, so a header copy would be redundant. The `lg:hidden` wrapper lives
 * in `header.tsx` with the rest of the band logic; this component only knows
 * its two sizes.
 * A `Link` and not a button. Settings is a real route, it is deep-linkable,
 * and a link can be opened in a new tab, copied, and reached with the back
 * button - all of which `router.push` quietly takes away. The rule that
 * `LocaleSwitcher` follows, "existing shell surfaces, never a top-level
 * destination", was written for a control that has no destination to go to;
 * Settings has one.
 *
 * `aria-current="page"` on the active route, because a footer full of links
 * that never indicate where you are is a footer people stop trusting.
 */
export function SettingsLink({ compact = false }: { compact?: boolean }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const active = pathname === "/settings" || pathname.startsWith("/settings/");
  return (
    <Link
      href="/settings"
      data-testid={compact ? "settings-link-compact" : "settings-link"}
      aria-current={active ? "page" : undefined}
      aria-label={t("nav.settings")}
      className={
        compact
          // The compact copy needs no `aurora-touch` floor of its own: `h-11`
          // already clears 44px.
          ? "flex h-11 w-11 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          // `aurora-touch` (Phase 54). Measured 36px tall on a touch-emulated
          // 1024x1366 tablet, which is the smallest target found anywhere in
          // the app by the width sweep - smaller even than the header's own
          // 40px search field. This is the sidebar-footer copy that shows
          // from `lg` up, and an iPad at 1024 renders it with a coarse
          // pointer.
          : "aurora-touch flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
      }
    >
      <SlidersHorizontalIcon size={18} className="shrink-0" />
      {!compact && <span className="truncate">{t("nav.settings")}</span>}
    </Link>
  );
}
