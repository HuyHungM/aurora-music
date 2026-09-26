"use server";

import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/dal/session";
import { setUserAppearance } from "@/lib/dal/appearance";
import { getRequestAppearance } from "@/lib/appearance/server";
import {
  APPEARANCE_COOKIE,
  APPEARANCE_COOKIE_MAX_AGE,
} from "@/lib/appearance/cookie";
import {
  decodeAppearance,
  encodeAppearance,
  resetAppearance,
  type Appearance,
} from "@/lib/appearance/appearance";
import {
  BACKGROUND_REJECTION_KEYS,
  checkBackgroundUrl,
  type BackgroundRejection,
} from "@/lib/appearance/background-image";

/**
 * Persists an appearance preference (Phase 53).
 *
 * Modelled directly on `setLocaleAction`, and that is deliberate: a
 * preference has exactly the same write semantics in both cases. The cookie
 * is always written, so the choice survives a reload for a signed-out visitor
 * and so a signed-in visitor's first paint after a change is already
 * correct; the account column is additionally written when there is a session,
 * so the choice follows the person to another browser.
 *
 * NEVER THROWS. It returns the applied appearance either way, which is what
 * lets the client adopt the server's answer deterministically instead of
 * guessing what was stored. A save that fails has to leave the interface
 * usable and truthful (§74), and an error boundary is neither.
 *
 * TWO INDEPENDENT REASONS IT CAN FAIL, reported differently:
 *
 *   - The value is rejected (`ok: false` with a reason). A background address
 *     that is not a legal https URL never reaches the cookie or the column.
 *     The check is `checkBackgroundUrl`, the same network-free function the
 *     browser ran, so the server is not trusting the client to have done it.
 *   - The write itself failed (`ok: false` with no reason). The cookie write
 *     is attempted first and its failure is reported; a cookie-write failure
 *     is what an anonymous visitor would actually experience, so it is the
 *     one worth naming.
 */
export type AppearanceActionResult =
  | { ok: true; appearance: Appearance; reason?: undefined }
  | {
      ok: false;
      appearance: Appearance;
      /** A `settings.backgroundError.*` message key, or absent on a write failure. */
      reason: string | undefined;
    };

/**
 * The background address a request is actually asking for, read without
 * decoding anything.
 *
 * `null` whenever there is nothing to check, which covers every request that
 * sets no custom background and the requests that are not objects at all. A
 * non-string `url` also yields `null`: that is an unusable FIELD rather than a
 * refused address, and `decodeAppearance` repairs it per field, which is the
 * documented failure mode for stored data and is not this action's to change.
 */
function requestedBackgroundUrl(input: unknown): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const background = (input as Record<string, unknown>).background;
  if (typeof background !== "object" || background === null) {
    return null;
  }
  const candidate = background as Record<string, unknown>;
  if (candidate.kind !== "url") {
    return null;
  }
  return typeof candidate.url === "string" ? candidate.url : null;
}

export async function setAppearanceAction(
  input: unknown,
): Promise<AppearanceActionResult> {
  // THE RAW ADDRESS, BEFORE THE DECODER SEES IT.
  //
  // A decoder's job is to turn untrusted stored data into something safe to
  // render, and quietly replacing an illegal address with "no background" is
  // exactly right for that. It is the wrong thing for a REQUEST: the user
  // pasted something, it was refused, and normalising it first would report
  // success for a setting that was never applied - a saved-looking empty
  // canvas with no explanation. So the request is read raw here, and the
  // decoder is left to do its own job on the way in.
  const rawUrl = requestedBackgroundUrl(input);

  if (rawUrl !== null) {
    const check = checkBackgroundUrl(rawUrl);
    if (!check.ok) {
      // THE CURRENTLY STORED VALUE, read back - NOT the requested one. This is
      // the whole point of returning `appearance` on a rejection: the client
      // has optimistically applied the value, so it needs to be told what is
      // actually in storage in order to roll back to it. Handing back the
      // value that was just refused would leave the interface displaying an
      // address that was never accepted, which is worse than the bad paste
      // because it is now presented as a saved setting.
      return {
        ok: false,
        appearance: await getRequestAppearance().catch(() => decodeAppearance(undefined)),
        reason: BACKGROUND_REJECTION_KEYS[check.reason as BackgroundRejection],
      };
    }
  }

  // `decodeAppearance` re-checks the address as part of reading it, and stores
  // the TRIMMED form, so there is nothing to normalise here: the value this
  // action goes on to persist is the one the decoder produced.
  const requested = decodeAppearance(input);

  try {
    const jar = await cookies();
    // THE COMPACT ENCODING, not the resolved object. `decodeAppearance`
    // produced a complete twelve-field value a moment ago, and writing THAT
    // would put ~240 bytes on a cookie attached to every same-origin request
    // for a visitor who has changed nothing - the exact thing the omission-
    // based format exists to avoid, and the thing `cookie.ts` documents as the
    // reason for the format. The two sinks also have to agree: the client
    // writes `encodeAppearance(...)` for the signed-out case, and a signed-in
    // user must not end up with a fatter cookie than an anonymous one for the
    // same preference.
    jar.set(APPEARANCE_COOKIE, JSON.stringify(encodeAppearance(requested)), {
      path: "/",
      maxAge: APPEARANCE_COOKIE_MAX_AGE,
      sameSite: "lax",
    });
  } catch {
    // The cookie is the only place a signed-out visitor's choice lives, so
    // this is the failure worth reporting. The account write below is not
    // attempted: a preference that half-saved is worse than one that did not
    // save, because the next request would resolve to the other half.
    //
    // `appearance` is the REQUESTED value here, not the stored one, and the
    // asymmetry with the rejection path above is deliberate. A rejected value
    // is one that will never be acceptable, so showing it would be a lie. A
    // failed write is one that is perfectly acceptable and only failed to
    // travel - reverting somebody's slider mid-interaction because a request
    // timed out is the worse failure, and the client surfaces the failure
    // through `status`/`reason` rather than by silently discarding the draft.
    return { ok: false, appearance: requested, reason: undefined };
  }

  try {
    const user = await getCurrentUser().catch(() => null);
    if (user) {
      await setUserAppearance(user.id, requested);
    }
  } catch {
    // Cookie already written; the account write retries on the next change.
  }
  return { ok: true, appearance: requested };
}

/**
 * Appearance reset (§60). Appearance and nothing else.
 *
 * A separate action rather than a flag on the setter, because "restore the
 * canonical defaults" is a distinct user intent with a distinct consequence
 * and it deserves to be one call the client can make without first having to
 * assemble the default document correctly. It is implemented as a write of the
 * default to BOTH sinks rather than as a delete from the account column,
 * because a deleted preference would immediately fall back to a cookie that
 * still holds the old choice - the reset would visibly undo itself.
 *
 * Queue, playback, likes, playlists and the account are not reachable from
 * either action. There is no code path from this module to any of them.
 */
export async function resetAppearanceAction(): Promise<AppearanceActionResult> {
  return setAppearanceAction(encodeAppearance(resetAppearance()));
}
