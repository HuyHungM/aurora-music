"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { signOutUser } from "@/app/actions/auth";
import type { User } from "@/lib/domain";
import type { Locale } from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { Avatar } from "@/components/ui/avatar";
import { ArrowDownIcon, LogOutIcon } from "@/components/ui/icons";

/**
 * The account control for every viewport below `lg`, and the only place Logout
 * lives there.
 *
 * WHY A DISCLOSURE AND NOT `role="menu"`. `role="menu"` implies arrow-key
 * navigation between items, Home/End, and typeahead. A two-row popover that
 * declares the role without implementing the keyboard contract is worse than one
 * that does not claim it: a screen reader announces "menu" and then the user's
 * arrow keys do nothing. This uses the disclosure pattern instead — a trigger
 * with `aria-expanded` and `aria-controls`, a labelled region, and ordinary
 * focusable controls inside — which is fully operable with Tab and Enter today
 * and claims nothing it does not deliver.
 *
 * WHY IT LIVES BELOW `lg`. From `lg` up the sidebar footer carries the full
 * account block: avatar, name, and its own sign-out. Duplicating that into a
 * popover would give a desktop user two sign-out controls and two Settings
 * links, and the mobile control would become a second, quieter copy of the
 * account section rather than a refinement of it. One account surface per
 * breakpoint band.
 *
 * POSITIONING, and why there is no flip logic here. The wrapper is
 * `position: relative`, so it — not the header, not the viewport — is the
 * containing block for the absolutely positioned panel. That matters more than
 * it looks: the header is `.aurora-glass`, and `backdrop-filter` makes an
 * element the containing block for its positioned descendants, so without the
 * relative wrapper the panel would anchor to the header's padding box and drift
 * from the avatar by exactly the header's own inset.
 *
 * `end-0` is `inset-inline-end`, not `right: 0`, so the panel stays flush with
 * the avatar in both writing directions.
 *
 * There is no above/below flip because there is nothing above it: the trigger
 * lives in a top-anchored bar, so "open downward" is the only correct answer at
 * every scroll position and every viewport height. Flip logic here would be dead
 * code that looks like it handles a case it cannot reach.
 *
 * The panel is capped against the viewport with `min(20rem, 100vw - 2rem)` so a
 * 320px phone cannot push it into horizontal scroll.
 */
export function ProfileMenu({
  user,
  locale,
}: {
  user: User;
  locale: Locale;
}) {
  const t = getT(locale);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  // Escape closes from anywhere inside, and focus goes back to the trigger so a
  // keyboard user is not dropped at the top of the document.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // Pointer-down outside. `pointerdown` rather than `click` so the menu is
  // already gone when the click lands on whatever was underneath, instead of
  // flashing for a frame.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) {
        return;
      }
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  // Moving focus into the panel on open, so Tab continues from the account
  // surface rather than from the top of the document.
  useEffect(() => {
    if (open) {
      panelRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    }
  }, [open]);

  const label = user.name ?? user.email ?? t("header.account");

  return (
    <div ref={wrapperRef} className="relative shrink-0 lg:hidden">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        aria-label={t("auth.accountMenuLabel", { name: label })}
        data-testid="profile-trigger"
        onClick={() => setOpen((value) => !value)}
        // `open` gets a real surface change, not only a colour change: the ring
        // and the raised background both move, so the state is legible without
        // relying on hue.
        className={`aurora-touch flex items-center gap-1 rounded-full border py-1 pl-1 pr-2 transition-colors ${
          open
            ? "border-border-strong bg-surface-active"
            : "border-border-subtle bg-surface-1 hover:bg-surface-hover"
        }`}
      >
        <Avatar name={user.name} image={user.image} size={28} />
        <ArrowDownIcon
          size={14}
          className={`shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t("auth.accountMenuLabel", { name: label })}
          data-testid="profile-menu"
          // `aurora-glass-float`: the same material the dialogs and menus
          // already use, so the panel reads as part of the shell rather than a
          // new surface invented for one control.
          className="aurora-glass-float absolute end-0 top-full z-dropdown mt-2 w-[min(20rem,calc(100vw-2rem))] origin-top-right rounded-2xl p-1.5"
        >
          {/* Identity, so the panel is self-explanatory once it is open and the
              compact trigger's hidden name is not on screen. */}
          <div className="flex items-center gap-3 rounded-xl px-2.5 py-2">
            <Avatar name={user.name} image={user.image} size={36} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-primary">
                {label}
              </p>
              {user.email && user.email !== label ? (
                <p className="truncate text-xs text-text-muted">{user.email}</p>
              ) : null}
            </div>
          </div>

          {/* The existing sign-out action and its existing form. The auth wiring
              is not reimplemented here: this is the same `signOutUser` server
              action the desktop control posts, so there is still exactly one
              logout in the application. */}
          <form action={signOutUser} className="mt-1 border-t border-border-subtle pt-1">
            <button
              type="submit"
              data-testid="profile-menu-signout"
              className="aurora-touch flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-sm font-medium text-danger transition-colors hover:bg-surface-hover"
            >
              <LogOutIcon size={18} className="shrink-0" />
              <span>{t("auth.signOut")}</span>
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
