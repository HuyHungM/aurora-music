import Link from "next/link";
import type { User } from "@/lib/domain";
import type { AuthAvailability } from "@/lib/auth/availability";
import { Brand } from "./brand";
import { SignInControl, SignOutControl } from "@/components/auth/controls";
import { Avatar } from "@/components/ui/avatar";
import { SearchIcon } from "@/components/ui/icons";

export function Header({
  user,
  availability,
}: {
  user: User | null;
  availability: AuthAvailability;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border-subtle bg-background/90 px-4 backdrop-blur lg:h-16 lg:px-8">
      <div className="lg:hidden">
        <Brand />
      </div>
      <div className="flex-1" />
      <Link
        href="/search"
        aria-label="Search"
        className="grid h-10 w-10 place-items-center rounded-full text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <SearchIcon size={20} />
      </Link>
      {user ? (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 rounded-full border border-border-subtle py-1 pl-1 pr-3">
            <Avatar name={user.name} image={user.image} size={28} />
            <span className="hidden max-w-36 truncate text-sm font-medium text-text-primary sm:block">
              {user.name ?? user.email ?? "Account"}
            </span>
          </span>
          <SignOutControl name={user.name} />
        </div>
      ) : (
        <SignInControl availability={availability} />
      )}
    </header>
  );
}