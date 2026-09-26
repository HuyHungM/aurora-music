"use server";

import { cookies } from "next/headers";

import {
  INSTALL_DISMISS_COOKIE,
  INSTALL_DISMISS_MAX_AGE_SECONDS,
} from "@/lib/pwa/install";

/**
 * Records that the visitor declined the install offer.
 *
 * A cookie rather than browser storage, because the repository quality gate
 * bans the browser storage APIs in production source and the locale
 * preference sets the precedent. Deliberately anonymous: this is a
 * UI-suppression bit, not user data, so it is never written to the database
 * and never tied to an account. It is `lax` and not `secure`-flagged here
 * because the same cookie must be readable on the plain-HTTP localhost
 * development origin.
 *
 * Never throws: the affordance is already gone from the UI by the time this
 * runs, so a failure to persist must not surface an error. Worst case the
 * offer reappears on a later visit.
 */
export async function dismissInstallPromptAction(): Promise<{ ok: boolean }> {
  try {
    const jar = await cookies();
    jar.set(INSTALL_DISMISS_COOKIE, String(Date.now()), {
      path: "/",
      maxAge: INSTALL_DISMISS_MAX_AGE_SECONDS,
      sameSite: "lax",
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
