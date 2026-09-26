"use server";

import { requireUser, getSessionUserId } from "@/lib/dal/session";
import { getKeepListening, setKeepListening } from "@/lib/dal/listening";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { guardServerAction, type GuardFailure } from "@/lib/api/action-guard";

export type KeepListeningActionResult =
  | { ok: true; enabled: boolean }
  | ({ ok: false; error: string } & Partial<GuardFailure>);

/**
 * Keep-listening is the cheapest of the four kill switches to honour on a read:
 * when it is off the stored preference is simply reported as off, and the UI
 * renders a normal disabled control. Returning an error here would turn an
 * operator decision into a broken page.
 *
 * On a write it does return FEATURE_DISABLED, because silently accepting a write
 * that does not happen is worse than saying no.
 */
const KEEP_LISTENING_OFF_MESSAGE = "Keep listening is unavailable right now.";

/**
 * Phase 47 "Keep listening" preference.
 *
 * Reads resolve for anonymous visitors to the OFF default rather than
 * failing, so the client has a defined value before sign-in and the
 * feature is never silently enabled for someone who cannot express a
 * preference. `authenticated` rides along on the same read so the toggle
 * needs no second round trip just to know whether to offer itself. Writes
 * require a session.
 */
export async function getKeepListeningAction(): Promise<{
  ok: boolean;
  enabled: boolean;
  authenticated: boolean;
}> {
  const userId = await getSessionUserId().catch(() => null);
  if (!userId) {
    return { ok: true, enabled: false, authenticated: false };
  }
  if (!isFeatureEnabled("infiniteListening")) {
    return { ok: true, enabled: false, authenticated: true };
  }
  try {
    return {
      ok: true,
      enabled: await getKeepListening(userId),
      authenticated: true,
    };
  } catch {
    return { ok: true, enabled: false, authenticated: true };
  }
}

export async function setKeepListeningAction(
  enabled: unknown,
): Promise<KeepListeningActionResult> {
  const denied = await guardServerAction({
    feature: "infiniteListening",
    featureOffMessage: KEEP_LISTENING_OFF_MESSAGE,
  });
  if (denied) {
    return denied;
  }
  try {
    const user = await requireUser();
    if (typeof enabled !== "boolean") {
      return { ok: false, error: "Invalid input" };
    }
    return { ok: true, enabled: await setKeepListening(user.id, enabled) };
  } catch {
    return { ok: false, error: "Failed to update preference" };
  }
}
