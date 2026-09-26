"use server";

import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/dal/session";
import { setUserEQ } from "@/lib/dal/audio-eq";
import { EQ_COOKIE, EQ_COOKIE_MAX_AGE } from "@/lib/audio/eq-cookie";
import { decodeEQ, encodeEQ, type EQConfig } from "@/lib/audio/eq";

/**
 * Persists an equalizer preference (Phase 53 addendum).
 *
 * Modelled directly on `setAppearanceAction`, and deliberately so: a preference
 * has the same write semantics in both cases, and having one shape for
 * preferences is worth more than any argument for a second one. The cookie is
 * always written, so the choice survives a reload for a signed-out visitor and
 * so a signed-in visitor's first paint after a change is already correct; the
 * account column is additionally written when there is a session, so the choice
 * follows the person to another browser.
 *
 * NEVER THROWS. It returns the applied configuration either way, which is what
 * lets the client adopt the server's answer deterministically instead of
 * guessing what was stored, and which keeps a failed save from becoming an
 * error boundary over an audio page.
 *
 * THE WRITE-FAILURE PATH RETURNS THE REQUESTED VALUE, deliberately. A failed
 * write is a perfectly acceptable value that failed to travel, and reverting
 * somebody's slider mid-interaction because a request timed out is the worse
 * failure; the client surfaces the failure through its own status rather than by
 * silently discarding the draft. This is the same asymmetry `setAppearanceAction`
 * documents, and the reasoning is the same.
 *
 * §39 SEPARATION, which is the property this action exists to preserve: it
 * reaches the EQ cookie and the EQ column and nothing else. It does not import
 * the playback session, the queue, the volume, or `player/persistence.ts`, so a
 * change here cannot travel with - or disturb - a position in a queue. A quality
 * gate asserts that separation rather than trusting this paragraph.
 */
export interface EQActionResult {
  ok: boolean;
  config: EQConfig;
}

export async function setEQAction(
  input: unknown,
): Promise<EQActionResult> {
  const requested = decodeEQ(input);

  try {
    const jar = await cookies();
    // THE COMPACT ENCODING, not the resolved configuration. `decodeEQ` just
    // produced a complete five-field value with ten band gains, and writing
    // THAT would put roughly 150 bytes on a cookie attached to every
    // same-origin request for a listener who has changed nothing - the exact
    // thing the omission-based format exists to avoid. The two sinks also have
    // to agree: the client root writes `encodeEQ(...)` for the signed-out case,
    // and a signed-in listener must not end up with a fatter cookie than an
    // anonymous one for the same preference.
    jar.set(EQ_COOKIE, JSON.stringify(encodeEQ(requested)), {
      path: "/",
      maxAge: EQ_COOKIE_MAX_AGE,
      sameSite: "lax",
    });
  } catch {
    // The cookie is the only place a signed-out listener's choice lives, so this
    // is the failure worth reporting. The account write below is not attempted:
    // a preference that half-saved is worse than one that did not save, because
    // the next request would resolve to the other half.
    return { ok: false, config: requested };
  }

  try {
    const user = await getCurrentUser().catch(() => null);
    if (user) {
      await setUserEQ(user.id, requested);
    }
  } catch {
    // Cookie already written; the account write retries on the next change.
  }
  return { ok: true, config: requested };
}

/**
 * NO RESET ACTION, and that is a decision rather than an omission.
 *
 * `setAppearanceAction` has a sibling `resetAppearanceAction`, because a reset
 * there means "write the default to both sinks" and having a named action for
 * it reads as intention. Here the same effect already falls out of the ordinary
 * write: the store resets to `DEFAULT_EQ`, the persistence root sees the
 * revision change, and `setEQAction` writes the default document to the cookie
 * AND the account column - which is precisely what a reset has to do, because a
 * deleted preference would fall straight back to a cookie still holding the old
 * choice and the reset would visibly undo itself on the next request.
 *
 * A dedicated reset action would therefore be a second write path for one
 * effect, with a second opportunity for the two to disagree about what the
 * default is. There is one write path, and the default is one constant.
 *
 * The default is the V-Shape with the equalizer OFF (`DEFAULT_EQ`). A listener
 * who has never enabled the equalizer gets the V-Shape waiting for them, not a
 * surprise: turning a DSP on for somebody who did not ask for it is exactly the
 * kind of decision a preference system should not make on their behalf.
 *
 * Playback, the queue, the volume and the playback session are unreachable from
 * this module.
 */
export type { EQConfig as EQActionConfig };
