import { cache } from "react";
import { cookies } from "next/headers";
import { getSessionUserId } from "@/lib/dal/session";
import { getUserEQ } from "@/lib/dal/audio-eq";
import { decodeEQ, type EQConfig } from "./eq";
import { EQ_COOKIE } from "./eq-cookie";

/**
 * Request EQ preference for server components (Phase 53 addendum).
 *
 * React-cached per request, with the same precedence `i18n/server.ts` uses for
 * locale and `appearance/server.ts` uses for appearance:
 *
 *   explicit authenticated preference (`User.audioEq`)
 *   → anonymous cookie
 *   → `DEFAULT_EQ`
 *
 * The cookie is honoured for a signed-in visitor who tuned the equalizer before
 * signing in: they have a cookie and no account row, and writing the account row
 * only on their next change is what stops the choice they just made from being
 * visibly discarded on the way in.
 *
 * EVERY STEP IS DEFENSIVE AND NONE OF THEM THROW. A failed EQ read must degrade
 * to the default curve and nothing else. A listening preference is the least
 * important thing the application knows, and it is not allowed to be the reason
 * a page does not render - least of all a page that is *about* to be playing
 * audio.
 *
 * §39: this is the audio preference path, and it shares no code, no column and
 * no cookie with the playback-session snapshot in `player/persistence.ts`. The
 * two are separate on purpose, and a quality gate enforces the separation.
 */
export const getRequestEQ = cache(async (): Promise<EQConfig> => {
  try {
    const userId = await getSessionUserId().catch(() => null);
    if (userId) {
      const saved = await getUserEQ(userId).catch(() => null);
      if (saved) {
        return saved;
      }
    }
  } catch {
    // Fall through to cookie/default — EQ must never break boot.
  }
  try {
    const jar = await cookies();
    const raw = jar.get(EQ_COOKIE)?.value;
    if (raw === undefined) {
      return decodeEQ(undefined);
    }
    // The cookie is user-writable, so a hand-edited value is simply another
    // untrusted input. `decodeEQ` is total and per-field, so a corrupt document
    // costs the user their curve and nothing else.
    return decodeEQ(JSON.parse(raw));
  } catch {
    return decodeEQ(undefined);
  }
});
