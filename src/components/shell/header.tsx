import type { User } from "@/lib/domain";
import type { AuthAvailability } from "@/lib/auth/availability";
import type { Locale } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { Brand } from "./brand";
import { SignInControl, SignOutControl } from "@/components/auth/controls";
import { ProfileMenu } from "@/components/shell/profile-menu";
import { SettingsLink } from "@/components/shell/settings-link";
import { Avatar } from "@/components/ui/avatar";
import { SearchField } from "@/components/search/search-field";

export function Header({
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
    // `min-h-16` + top safe-area padding, not `h-16`: with
    // `viewportFit: "cover"` (layout.tsx) the header now paints up into the
    // status bar / notch area, so the inset has to become real height. A fixed
    // `h-16` would instead squeeze the search field and the account controls.
    // `min-h-16` keeps the bar exactly 4rem tall wherever the inset is 0 —
    // every desktop browser and every phone in browser mode — so the browser
    // presentation is unchanged and only installed/notched devices grow.
    // `aurora-glass` replaces `bg-background/85 backdrop-blur-md`, and both
    // are removed rather than left alongside it (Phase 53, §75). The
    // `data-aurora-glass="on"` rule sets `background-color` and
    // `backdrop-filter` at a specificity that beats a Tailwind utility, so
    // leaving the old classes would have left dead declarations that read as
    // the styling in the source and are not. With Glass Mode off, none of it
    // applies and the header is the pre-Phase-53 header.
    <header className="aurora-glass sticky top-0 z-sticky flex min-h-16 items-center gap-3 border-b border-border-subtle pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] lg:pl-8 lg:pr-8">
      {/* Phase 54: every fixed-size child below carries `shrink-0`, and the
          brand deliberately does not.

          Measured at 390px, the row needed ~346px of children inside a 358px
          content box - but the wordmark is revealed again above its threshold
          (`max-[392px]:hidden` in `brand.tsx`), and with it the row needed
          more than the box had. Nothing scrolled at first: because flex
          children default to `shrink: 1`, the row silently absorbed the
          overflow by compressing the controls. The 44px search button came
          back 39px wide at 380px and stayed under 44px all the way to 390px -
          a touch target quietly smaller than the one the class declares, in
          exactly the band where the wordmark appears.

          `shrink-0` on the four controls flips the failure mode to the
          opposite one, which is the right trade: a control never deforms
          below the target it declares. But applying it to the BRAND as well
          re-created the original bug in its other form - the wordmark became
          unshrinkable, so the row overflowed instead of compressing, and
          because the row overflows to the right, the document scrolls
          sideways. Re-measured with `shrink-0` on the brand: 399px of row in
          a 390px viewport, 9px of horizontal document scroll on every
          authenticated page.

          So the brand is the row's one elastic child (`min-w-0`, not
          `shrink-0`) and the wordmark inside it is `truncate` with `min-w-0`.
          It yields first, and the 36px mark keeps its 44px target from
          `aurora-touch` regardless, because `min-width` is not something
          shrinking can take away. The threshold in `brand.tsx` is sized so
          this elasticity is never needed in practice; it is the guarantee
          that a wrong threshold degrades instead of breaking. */}
      <div className="min-w-0 lg:hidden">
        <Brand />
      </div>
      {/* Global search: the fastest path to PLAY lives in the top bar.
          Same shared client field as the /search page, so the two can
          never diverge in how they navigate (§11, §29). It mounts no
          `defaultValue`: the header is shared by every route, so it
          mirrors whatever `?q=` the current URL carries. */}
      <SearchField
        id="global-search"
        variant="header"
        label={t("header.searchLabel")}
        placeholder={t("header.searchPlaceholder")}
        clearLabel={t("searchForm.clear")}
        searchingLabel={t("searchForm.searching")}
      />
      {/* Elastic spacer: absorbs the slack below `md` so the account group
          stays hard against the trailing edge. `flex-1 md:hidden` - the
          `md:hidden` is load-bearing and must not be flipped: at `md` and up
          the real search field takes over the slack instead. */}
      <div className="flex-1 md:hidden" />
      {/* THE ROUTE TO SETTINGS below `lg`, and the mobile navbar's replacement
          for the language switcher it used to carry.

          Two owners used to share one slot by band: a compact language switcher
          below `md`, and this link from `md` to `lg`. The band split existed
          because a phone had no room for a second destination — and it bought a
          language control on the one surface where changing the interface
          language is the least useful thing a listener can do mid-listen.

          Settings is strictly better in that slot: it is the route that already
          hosts the full language switcher, so removing the compact copy makes no
          preference unreachable, while adding a destination that was previously
          unreachable below `lg` at all. One control, one band, no `md:`
          arithmetic left to reason about. */}
      <div className="shrink-0 lg:hidden">
        <SettingsLink compact />
      </div>
      {user ? (
        <>
          {/* Desktop keeps the full account block: the avatar with the name
              beside it and its own sign-out, exactly as before. The popover is
              a mobile refinement, not a replacement, so a desktop user never
              sees two sign-out controls. */}
          <div className="hidden shrink-0 items-center gap-2 lg:flex">
            <span className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-1 py-1 pl-1 pr-3">
              <Avatar name={user.name} image={user.image} size={28} />
              <span className="max-w-36 truncate text-sm font-medium text-text-primary">
                {user.name ?? user.email ?? t("header.account")}
              </span>
            </span>
            <SignOutControl name={user.name} locale={locale} />
          </div>
          <ProfileMenu user={user} locale={locale} />
        </>
      ) : (
        <SignInControl availability={availability} locale={locale} />
      )}
    </header>
  );
}
