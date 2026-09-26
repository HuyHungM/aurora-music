"use server";

import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/dal/session";
import { setUserLocale } from "@/lib/dal/locale";
import {
  LOCALE_COOKIE,
  resolveLocale,
  type Locale,
} from "@/lib/i18n/locale";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Persists an explicit language choice. Always writes the anonymous
 * cookie (display continuity); additionally saves the account
 * preference when signed in. Never throws — returns the applied locale
 * so the client can sync deterministically.
 */
export async function setLocaleAction(
  locale: unknown,
): Promise<{ ok: boolean; locale: Locale }> {
  const next = resolveLocale(locale);
  try {
    const jar = await cookies();
    jar.set(LOCALE_COOKIE, next, {
      path: "/",
      maxAge: COOKIE_MAX_AGE,
      sameSite: "lax",
    });
  } catch {
    return { ok: false, locale: next };
  }
  try {
    const user = await getCurrentUser().catch(() => null);
    if (user) {
      await setUserLocale(user.id, next);
    }
  } catch {
    // Cookie already saved; the account write retries on next change.
  }
  return { ok: true, locale: next };
}
