"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/i18n/locale-provider";
import { CogIcon } from "@/components/ui/icons";

/**
 * The one control that routes to Settings (Phase 53).
 *
 * Rendered twice - in the sidebar footer on desktop, in the header on
 * small viewports - and it is ONE component so the two cannot drift. That
 * matters more here than for most shared controls: the sidebar is
 * `hidden lg:flex`, so without the header copy a phone would have no way to
 * reach Appearance at all, and a feature nobody can reach on a phone is not a
 * feature.
 *
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
          ? "flex h-11 w-11 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
          // `aurora-touch` (Phase 54). Measured 36px tall on a touch-emulated
          // 1024x1366 tablet, which is the smallest target found anywhere in
          // the app by the width sweep - smaller even than the header's own
          // 40px search field. The compact copy is already `h-11`; this is
          // the sidebar-footer copy that shows from `lg` up, and an iPad at
          // 1024 renders it with a coarse pointer.
          : "aurora-touch flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
      }
    >
      <CogIcon size={18} className="shrink-0" />
      {!compact && <span className="truncate">{t("nav.settings")}</span>}
    </Link>
  );
}
