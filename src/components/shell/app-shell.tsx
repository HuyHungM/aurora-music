import type { ReactNode } from "react";
import type { User } from "@/lib/domain";
import type { AuthAvailability } from "@/lib/auth/availability";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { NavList } from "./nav-item";
import { PlayerHost } from "@/components/player/player-host";

export function AppShell({
  user,
  availability,
  children,
}: {
  user: User | null;
  availability: AuthAvailability;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border-subtle bg-surface-1 lg:flex">
        <Sidebar user={user} availability={availability} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        <Header user={user} availability={availability} />
        <main className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 pb-[calc(7rem+env(safe-area-inset-bottom))] pt-6 lg:px-8 lg:pb-[calc(6rem+2rem)] lg:pt-8">
          {children}
        </main>
      </div>

      <nav
        aria-label="Main navigation"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border-subtle bg-surface-1 lg:hidden"
      >
        <div className="flex h-12 items-center justify-around pb-[env(safe-area-inset-bottom)]">
          <NavList orientation="bottom" />
        </div>
      </nav>

      <PlayerHost />
    </div>
  );
}