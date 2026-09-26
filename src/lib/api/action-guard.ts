/**
 * One guard for every hardened server action (Phase 52, RULE 12 + RULE 48).
 *
 * Why a shared helper: applying rate limiting and a kill switch is two steps at
 * the top of an action, and doing that by hand in eight files is how eight
 * slightly different policies end up existing. This function is the only place
 * that decides, in order:
 *
 *   1. Is the feature switched off?      -> FEATURE_DISABLED, no budget spent.
 *   2. Is the caller within budget?      -> RATE_LIMITED, with a truthful
 *                                          retry-after.
 *   3. Otherwise: proceed.
 *
 * Feature check before rate check on purpose. A feature that is switched off
 * does not call providers at all, so charging its callers for a budget they
 * cannot spend would be wrong - and a kill switch that could itself be
 * rate-limited into uselessness is not a kill switch.
 *
 * It returns a value rather than throwing, because every Aurora server action
 * has a `{ ok: false, error: string }` result contract and turning a policy
 * decision into an unhandled rejection would change how failures surface in the
 * client. The stable `code` travels alongside the existing human-readable
 * `error`, so this is purely additive: a caller reading only `error` is
 * unaffected.
 */

import { classifyError, type ClientErrorCode } from "@/lib/api/error-codes";
import { newRequestId } from "@/lib/api/request-id";
import { isFeatureEnabled, type FeatureFlagName } from "@/lib/feature-flags";
import { guardRateLimit } from "@/lib/http/rate-limit-server";
import type { RateLimitBucketName } from "@/lib/http/rate-limit";

/**
 * The failure shape added to an action's existing `ok: false` result.
 *
 * `ok: false` is part of the type rather than added at each call site, so a
 * guard result is directly assignable to every action contract it is spliced
 * into - `return denied;` is the whole call site, with no re-wrapping and no
 * chance of one action forgetting to mark the result as a failure.
 */
export interface GuardFailure {
  readonly ok: false;
  readonly error: string;
  readonly code: ClientErrorCode;
  readonly requestId: string;
  /** Present only for RATE_LIMITED, so a client can back off truthfully. */
  readonly retryAfterMs?: number;
}

/**
 * The guard fields without `error`, for actions whose existing failure shape
 * already carries a structured error of a different type (playback resolution
 * returns a `SerializedEngineError`, not a string). Intersecting that with
 * `Partial<GuardFailure>` would produce `SerializedEngineError & string`,
 * which is unsatisfiable, so the string field is omitted rather than
 * intersected.
 */
export type GuardFailureMeta = Omit<Partial<GuardFailure>, "error">;

export interface ActionGuardOptions {
  /**
   * The kill switch that governs this action. When supplied and off, the action
   * returns FEATURE_DISABLED without doing any work.
   */
  readonly feature?: FeatureFlagName;
  /** Message shown when the feature is off. Must be user-facing, not a code. */
  readonly featureOffMessage: string;
  /** The rate-limit bucket to charge. Omit for cheap actions. */
  readonly bucket?: RateLimitBucketName;
  /** Skip the session lookup when the caller already knows the user id. */
  readonly userId?: string | null;
}

/**
 * Returns `null` when the action may proceed, or a failure to return as-is.
 */
export async function guardServerAction(
  options: ActionGuardOptions,
): Promise<GuardFailure | null> {
  if (options.feature && !isFeatureEnabled(options.feature)) {
    return {
      ok: false,
      error: options.featureOffMessage,
      code: "FEATURE_DISABLED",
      requestId: newRequestId(),
    };
  }

  if (!options.bucket) {
    return null;
  }

  try {
    await guardRateLimit(options.bucket, { userId: options.userId });
    return null;
  } catch (error) {
    const payload = classifyError(error);
    const retryAfterMs =
      typeof (error as { retryAfterMs?: unknown }).retryAfterMs === "number"
        ? (error as { retryAfterMs: number }).retryAfterMs
        : undefined;
    return {
      ok: false,
      error: payload.message,
      code: payload.code,
      requestId: newRequestId(),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
  }
}
