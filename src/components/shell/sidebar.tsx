import type { User } from "@/lib/domain";
import type { AuthAvailability } from "@/lib/auth/availability";
import type { Locale } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { Brand } from "./brand";
import { NavList } from "./nav-item";
import { SignInControl, SignOutControl } from "@/components/auth/controls";
import { LocaleSwitcher } from "@/components/i18n/locale-switcher";
import { SettingsLink } from "@/components/shell/settings-link";
import { InstallPrompt } from "@/components/pwa/install-affordance";
import { Avatar } from "@/components/ui/avatar";

export function Sidebar({
  user,
  availability,
  locale,
}: {
  user: User | null;
  availability: AuthAvailability;
  locale: Locale;
}) {
  const t = getT(locale);
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-6">
        <Brand />
      </div>
      <p className="t-caption px-8 pb-2 pt-7 uppercase tracking-[0.14em]">{t("nav.browse")}</p>
      <div className="flex-1 overflow-y-auto px-3">
        {/* Phase 54: `NavList` no longer renders its own `<nav>`, so the
            landmark is declared here, where the navigation region actually
            is. Previously the sidebar list and the bottom rail each produced
            a landmark AND the rail produced a second nested one with the same
            accessible name. */}
        <nav aria-label={t("nav.main")}>
          <NavList orientation="sidebar" />
        </nav>
      </div>
      <div className="flex flex-col gap-2 border-t border-border-subtle p-3">
        {/* Install affordance lives in the application menu on desktop
            (Phase 51). The same component is also rendered at the top of the
            content area for small viewports, where this sidebar does not
            exist; both read the one install authority, so they can never
            disagree. Renders nothing unless there is a real offer. */}
        <InstallPrompt />
        {/* Settings sits in the footer rather than in `navItems` (Phase 53).
            A listener looks for account-level things where the language
            switcher and the sign-in control already are, and the alternative -
            a fifth item in the primary navigation - would be the most
            prominent control in the application for the thing people change
            once. `navItems` is deliberately unchanged. */}
        <SettingsLink />
        <LocaleSwitcher />
        {user ? (
          <div className="flex items-center gap-2 rounded-xl bg-surface-1 p-1.5">
            <span className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1">
              <Avatar name={user.name} image={user.image} size={32} />
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[13px] font-semibold text-text-primary">
                  {user.name ?? user.email ?? t("header.account")}
                </span>
                <span className="truncate text-[11px] text-text-muted">{t("sidebar.yourLibrary")}</span>
              </span>
            </span>
            <SignOutControl name={user.name} locale={locale} />
          </div>
        ) : (
          <SignInControl availability={availability} locale={locale} />
        )}
      </div>
    </div>
  );
}
