import type { ReactNode } from "react";
import type { User } from "@/lib/domain";
import type { AuthAvailability } from "@/lib/auth/availability";
import { cookies } from "next/headers";
import { listUserLikes } from "@/lib/dal/like";
import { getRequestLocale } from "@/lib/i18n/server";
import { getT } from "@/lib/i18n/translate";
import { getRequestAppearance } from "@/lib/appearance/server";
import { INSTALL_DISMISS_COOKIE } from "@/lib/pwa/install";
import { AppearanceRoot } from "@/components/appearance/appearance-root";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { NavList } from "./nav-item";
import { PlayerHost } from "@/components/player/player-host";
import { SignInControl } from "@/components/auth/controls";
import { InstallProvider } from "@/components/pwa/install-prompt";
import { InstallPrompt, InstalledAnnouncement } from "@/components/pwa/install-affordance";
import {
  AuthPromptHost,
  LikedTracksProvider,
} from "@/components/tracks/liked-tracks";

export async function AppShell({
  user,
  availability,
  children,
}: {
  user: User | null;
  availability: AuthAvailability;
  children: ReactNode;
}) {
  const locale = await getRequestLocale();
  const t = getT(locale);
  // Seed for the single client mirror of DAL likes (Phase 38): the
  // provider's optimistic toggles roll back against this same table,
  // so rows, menus, player, and track page can never diverge.
  const initialLiked = user
    ? (await listUserLikes(user.id, { limit: 1000 })).map(
        (like) => `${like.provider}:${like.trackId}`,
      )
    : [];
  // Anonymous install opt-out, read once here and handed to the single
  // install authority so the affordance stays hidden across navigations
  // instead of returning on every route (Phase 51). Read defensively: a
  // failed cookie read must not take the shell down.
  const installDismissed = await cookies()
    .then((jar) => jar.has(INSTALL_DISMISS_COOKIE))
    .catch(() => false);
  // Resolved here, once, and handed to `AppearanceRoot` as a prop. Two
  // independent reasons the shell root is the right place for it:
  //
  //   - `AppearanceRoot` renders the element the eight custom properties and
  //     the four `data-aurora-*` attributes have to sit on, because it is an
  //     ancestor of every surface. It cannot be a provider floating above
  //     the layout with nothing of its own to write to.
  //   - Resolving on the server is what removes the flash. The value is in
  //     the first HTML response, so the very first painted frame is the
  //     user's theme rather than the default one being corrected a frame
  //     later. Reading it inside the client component would mean a client
  //     fetch, and a client fetch means a wrong first frame.
  //
  // `getRequestAppearance` never throws - every step of it is defensive -
  // so a failed read costs the default theme and nothing more.
  const appearance = await getRequestAppearance();

  return (
    // `AppearanceRoot` replaces this div. It keeps the same layout classes and
    // the same `flex min-h-dvh` box, and drops only `bg-background`: the
    // backdrop layer inside it paints the canvas now, so a background image
    // can be visible through the content area rather than only in the
    // margins. `body` still paints the same colour underneath, which covers
    // the pre-hydration frame and anything outside the shell.
    <AppearanceRoot initial={appearance} authenticated={user !== null}>
      <InstallProvider initiallyDismissed={installDismissed}>
        <LikedTracksProvider
          initialLiked={initialLiked}
          isAuthenticated={user !== null}
        >
          {/* The sidebar is the one surface that was already `background-subtle`
              at full opacity with no blur, so Glass Mode is a genuine change
              here: it becomes translucent and blurred. §31 allows it a
              stronger glass layer than the rest of the chrome, and the reason
              is structural rather than aesthetic - it is a tall fixed column
              with a list of controls behind it, so a firmer backdrop is what
              keeps the labels legible against whatever is on the other side.
              `lg:flex` still governs: there is no nested blur to worry about
              because the sidebar and the header are siblings, not parents. */}
          <aside className="aurora-glass fixed inset-y-0 left-0 z-rail hidden w-66 flex-col border-r border-border-subtle lg:flex lg:w-66">
            <Sidebar user={user} availability={availability} locale={locale} />
          </aside>

          <div className="flex min-w-0 flex-1 flex-col lg:pl-66">
            <Header user={user} availability={availability} locale={locale} />
            {/* Side insets keep content clear of a landscape notch now that
                `viewportFit: "cover"` lets the page extend to the display
                edge; the bottom inset is handled by the navigation itself,
                which is the bottom-most element and must own it alone. */}
            <main className="mx-auto w-full min-w-0 max-w-[76rem] flex-1 pb-[calc(8.5rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-6 sm:pl-6 sm:pr-6 lg:px-10 lg:pb-[calc(6rem+2.5rem)] lg:pt-9">
              {/* Small viewports only: the sidebar that hosts the desktop
                  copy of the install affordance is `hidden lg:flex`, so
                  without this the offer would be unreachable on exactly the
                  devices where installing matters most. In normal flow, so it
                  cannot overlap the player or the bottom navigation. */}
              <InstallPrompt className="mb-4 lg:hidden" />
              {children}
            </main>
          </div>

          <nav
            aria-label={t("nav.main")}
            className="aurora-glass fixed inset-x-0 bottom-0 z-rail border-t border-border-subtle pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] lg:hidden"
          >
            {/* The home-indicator inset is on the <nav>, not on this row.
                Phase 54: the row used to be a fixed `h-16` (64px) with
                `pb-[env(safe-area-inset-bottom)]` INSIDE it. With
                `box-sizing: border-box` those cannot both hold - a 34px
                inset leaves a 30px content box, so each link's declared
                `min-h-12` (48px) box spilled 18px back out over the
                indicator and the effective clearance fell to 16px. Making
                the row `min-h-16` and letting the nav grow means the links
                always get their full 48px and the inset is added on top,
                which also keeps the nav's top edge at exactly
                `4rem + inset` - the same expression the mini player is
                positioned by, so the two cannot drift apart. */}
            <div className="flex min-h-16 items-stretch justify-around">
              <NavList orientation="bottom" />
            </div>
          </nav>

          <PlayerHost />
          {/* Announced once, politely, when the app is running installed. */}
          <InstalledAnnouncement />
        </LikedTracksProvider>
      </InstallProvider>
      <AuthPromptHost
        signIn={<SignInControl availability={availability} locale={locale} />}
      />
    </AppearanceRoot>
  );
}
