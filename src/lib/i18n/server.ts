import { cache } from "react";
import { cookies } from "next/headers";
import { getSessionUserId } from "@/lib/dal/session";
import { getUserLocale } from "@/lib/dal/locale";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locale";

/**
 * Request locale for server components/actions (Phase 42).
 * React-cached per request. Deterministic precedence:
 *
 *   explicit authenticated preference
 *   → anonymous cookie preference
 *   → Vietnamese default
 *
 * A saved account preference is never overwritten by the cookie here;
 * writes happen only through the explicit set-locale action.
 */
export const getRequestLocale = cache(async (): Promise<Locale> => {
  try {
    const userId = await getSessionUserId().catch(() => null);
    if (userId) {
      const saved = await getUserLocale(userId).catch(() => null);
      if (saved) {
        return saved;
      }
    }
  } catch {
    // Fall through to cookie/default — locale must never break boot.
  }
  try {
    const jar = await cookies();
    return resolveLocale(jar.get(LOCALE_COOKIE)?.value);
  } catch {
    return resolveLocale(undefined);
  }
});
