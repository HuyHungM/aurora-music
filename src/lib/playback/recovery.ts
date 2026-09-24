/**
 * Phase 16 — Playback resilience policy.
 *
 * Pure, engine-free definitions for failure classification, bounded retry
 * budgets, stall thresholds, and recovery diagnostics. The PlaybackController
 * executes this policy; nothing here touches audio, the store, or the UI.
 *
 * Model (controller-owned, ephemeral — never persisted, never queued):
 *
 * ```text
 * engine error / stall detected
 *   ↓  (same stable identity, same source order — never a new search)
 * attempt 1 → short delay → fresh resolve → reload at saved position
 *   ↓ failure (transient)
 * attempt 2 → longer delay → fresh resolve → reload at saved position
 *   ↓ failure again, or permanent failure at any point
 * final trackError (stay on track; existing queue semantics preserved)
 * ```
 *
 * Every attempt runs under the controller's resolution generation, so a
 * user action (next/prev/new play/stop/shutdown) supersedes pending work
 * and stale results stay inert.
 */

import {
  EngineError,
  ExtractorError,
  NormalizationError,
  PlaybackResolutionError,
  TrackMatchError,
  TrackNotFoundError,
} from "@/lib/domain";
import { PlayerError } from "@/lib/player/engine";

/**
 * Resolve+reload rounds per automatic recovery cycle.
 *
 * Rationale: one immediate-feeling retry covers expired URLs and single
 * blips; a second delayed retry covers slightly-longer transient network
 * trouble. Anything more would add user-facing latency without meaningfully
 * improving recovery odds — two failures of FRESH sources means the problem
 * is not transient staleness.
 */
export const MAX_RECOVERY_ATTEMPTS = 2;

/**
 * Delay before recovery attempt N (index N-1).
 *
 * Rationale: the first retry fires fast enough to feel instant for the
 * common expired-URL case while letting error-event storms settle; the
 * second waits longer to give transient network issues a real window.
 * Worst-case added latency is ~1s plus resolution time. No jitter:
 * deterministic timing keeps the suite stable.
 */
export const RECOVERY_RETRY_DELAYS_MS: readonly number[] = [200, 800];

/**
 * No-progress duration that counts as a stall while playback is expected.
 *
 * Rationale: ordinary buffering almost always shows progress (or ends)
 * well inside 5s, while the engine relays throttled timeupdates every
 * 250ms — twenty missed quanta plus a waiting/stalled signal (or total
 * event silence) is strong evidence, not a blip. Conservative by design:
 * false recoveries interrupt audio, missed stalls merely delay recovery
 * until the next signal.
 */
export const STALL_THRESHOLD_MS = 5000;

/**
 * Minimum position advance that counts as playback progress.
 * One engine timeupdate quantum (TIMEUPDATE_THROTTLE_MS = 250ms).
 */
export const STALL_PROGRESS_EPSILON_S = 0.25;

/**
 * Window after an explicit seek during which lack of progress is not a
 * stall. Seeking legitimately pauses timeupdates while the element
 * rebuffers at the new position.
 */
export const SEEK_STALL_GRACE_MS = 2000;

export function delayForRecoveryAttempt(attempt: number): number {
  if (attempt <= 1) {
    return RECOVERY_RETRY_DELAYS_MS[0] ?? 0;
  }
  return RECOVERY_RETRY_DELAYS_MS[Math.min(attempt, RECOVERY_RETRY_DELAYS_MS.length) - 1] ?? 0;
}

/**
 * Failure categories for recovery decisions. Derived ONLY from structured
 * errors (Aurora hierarchy + classified media codes) — never from raw
 * error strings or URLs.
 */
export type FailureCategory =
  | "transient"
  | "source"
  | "permanent"
  | "autoplay"
  | "aborted"
  | "unknown";

export interface ClassifiedFailure {
  category: FailureCategory;
  /** True when a fresh resolution round is worth attempting. */
  retryable: boolean;
}

/**
 * Maps any failure into a recovery category.
 *
 * - transient: infrastructure trouble (network, timeouts, retryable
 *   upstream) — worth a bounded retry.
 * - source: the URL/format itself is suspect (decode, src-not-supported,
 *   expired) — worth ONE fresh resolution since a new format may fix it;
 *   the attempt budget stops format loops.
 * - permanent: retrying the same identity cannot help (no playable source,
 *   invalid id, private/deleted video, validation) — fail immediately.
 * - autoplay: needs a user gesture, not a retry.
 * - aborted: superseded load, not a failure at all.
 * - unknown: unrecognized shape — conservative alone, but inside an
 *   already-started recovery cycle it is treated as transient because a
 *   playback failure is already known and the budget bounds the risk.
 */
export function classifyFailure(error: unknown): ClassifiedFailure {
  if (error instanceof PlayerError) {
    if (error.kind === "autoplay") {
      return { category: "autoplay", retryable: false };
    }
    switch (error.mediaCode) {
      case 1:
        return { category: "aborted", retryable: false };
      case 2:
        return { category: "transient", retryable: true };
      case 3:
      case 4:
        return { category: "source", retryable: true };
      default:
        break;
    }
    if (error.kind === "unavailable") {
      return { category: "permanent", retryable: false };
    }
    return { category: "transient", retryable: true };
  }
  if (error instanceof PlaybackResolutionError) {
    // Match stage means the identity has no playable source at all:
    // re-resolving the same identity cannot help.
    if (error.stage === "match") {
      return { category: "permanent", retryable: false };
    }
    return error.retryable
      ? { category: "transient", retryable: true }
      : { category: "permanent", retryable: false };
  }
  if (error instanceof ExtractorError) {
    return error.retryable
      ? { category: "transient", retryable: true }
      : { category: "permanent", retryable: false };
  }
  if (
    error instanceof NormalizationError ||
    error instanceof TrackNotFoundError ||
    error instanceof TrackMatchError
  ) {
    return { category: "permanent", retryable: false };
  }
  if (error instanceof EngineError) {
    return error.retryable
      ? { category: "transient", retryable: true }
      : { category: "permanent", retryable: false };
  }
  return { category: "unknown", retryable: false };
}

/**
 * Resume target for a recovered source: the latest known position,
 * clamped into the fresh source duration when that duration is known.
 * Unknown duration (<= 0) passes through — the element clamps naturally.
 */
export function clampResumePosition(
  positionSeconds: number,
  durationSeconds: number,
): number {
  const safe = Number.isFinite(positionSeconds) && positionSeconds > 0
    ? positionSeconds
    : 0;
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return Math.min(safe, durationSeconds);
  }
  return safe;
}

export type RecoveryPhase =
  | "idle"
  | "resolving"
  | "awaiting-outcome"
  | "backoff"
  | "recovered"
  | "failed";

/**
 * Internal diagnostics for the current or most recent recovery cycle.
 * Deliberately URL-free: stable track key, category, attempts, outcome.
 */
export interface RecoveryDiagnostics {
  phase: RecoveryPhase;
  /** Stable `provider:id` of the recovering track (never a URL). */
  trackKey: string | null;
  attemptsUsed: number;
  maxAttempts: number;
  lastFailureCategory: FailureCategory | null;
  updatedAtMs: number;
}

export function idleDiagnostics(nowMs: number): RecoveryDiagnostics {
  return {
    phase: "idle",
    trackKey: null,
    attemptsUsed: 0,
    maxAttempts: MAX_RECOVERY_ATTEMPTS,
    lastFailureCategory: null,
    updatedAtMs: nowMs,
  };
}
