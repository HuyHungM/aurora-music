import { cache } from "react";
import { cookies } from "next/headers";
import { getSessionUserId } from "@/lib/dal/session";
import { getUserAppearance } from "@/lib/dal/appearance";
import { decodeAppearance, type Appearance } from "./appearance";
import { APPEARANCE_COOKIE } from "./cookie";

/**
 * Request appearance for server components (Phase 53).
 *
 * React-cached per request, and the precedence is the same one
 * `i18n/server.ts` uses for locale, for the same reason: a saved account
 * preference is never overwritten by the cookie, and writes only ever happen
 * through the explicit action in `app/actions/appearance.ts`.
 *
 *   explicit authenticated preference (`User.appearance`)
 *   → anonymous cookie
 *   → `DEFAULT_APPEARANCE`
 *
 * The order matters more here than it does for locale, because the appearance
 * carries a URL. A signed-in visitor who tuned the glass before signing in
 * has a cookie and no account row; the cookie is honoured on that first
 * request and the account row is written on their next change, so the choice
 * they just made is never visibly discarded on the way in.
 *
 * EVERY STEP IS DEFENSIVE AND NONE OF THEM THROW. This runs in the root
 * layout of every authenticated route, so a failed appearance read must
 * degrade to the default theme and nothing else. That is a hard requirement
 * rather than good manners: an appearance preference is the least important
 * thing the application knows, and it is not allowed to be the reason a page
 * does not render.
 */
export const getRequestAppearance = cache(async (): Promise<Appearance> => {
  try {
    const userId = await getSessionUserId().catch(() => null);
    if (userId) {
      const saved = await getUserAppearance(userId).catch(() => null);
      if (saved) {
        return saved;
      }
    }
  } catch {
    // Fall through to cookie/default — appearance must never break boot.
  }
  try {
    const jar = await cookies();
    const raw = jar.get(APPEARANCE_COOKIE)?.value;
    if (raw === undefined) {
      return decodeAppearance(undefined);
    }
    // The cookie is a JSON string, and it is user-writable: a hand-edited
    // value is simply another untrusted input. `decodeAppearance` is total
    // and returns the default for anything it cannot read, so a corrupt
    // cookie costs the user their glass setting and nothing else.
    return decodeAppearance(JSON.parse(raw));
  } catch {
    return decodeAppearance(undefined);
  }
});
