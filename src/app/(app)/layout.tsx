import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/dal/session";
import { getAuthAvailability } from "@/lib/auth/availability";
import { getEnv } from "@/lib/config/env";
import { AppShell } from "@/components/shell/app-shell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const [user] = await Promise.all([getCurrentUser()]);
  const availability = getAuthAvailability(getEnv());
  return (
    <AppShell user={user} availability={availability}>
      {children}
    </AppShell>
  );
}