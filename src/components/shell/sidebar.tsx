import type { User } from "@/lib/domain";
import type { AuthAvailability } from "@/lib/auth/availability";
import { Brand } from "./brand";
import { NavList } from "./nav-item";
import { SignInControl, SignOutControl } from "@/components/auth/controls";
import { Avatar } from "@/components/ui/avatar";

export function Sidebar({
  user,
  availability,
}: {
  user: User | null;
  availability: AuthAvailability;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-5">
        <Brand />
      </div>
      <div className="mt-6 flex-1 overflow-y-auto px-3">
        <NavList orientation="sidebar" />
      </div>
      <div className="border-t border-border-subtle p-3">
        {user ? (
          <div className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5">
              <Avatar name={user.name} image={user.image} size={30} />
              <span className="truncate text-sm font-medium text-text-primary">
                {user.name ?? user.email ?? "Account"}
              </span>
            </span>
            <SignOutControl name={user.name} />
          </div>
        ) : (
          <SignInControl availability={availability} />
        )}
      </div>
    </div>
  );
}