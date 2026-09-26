/**
 * Install-affordance state machine (Phase 51).
 *
 * Deliberately pure and free of React: the interesting logic of "may I offer
 * to install Aurora, and which flavour of offer" is a small decision table,
 * and keeping it out of the component means it can be exhaustively tested
 * without a DOM, a browser, or a fake `BeforeInstallPromptEvent`.
 *
 * This module never triggers an install. It only classifies the runtime and
 * decides what the UI may truthfully say. Prompting is a user-intent action
 * owned by the component (RULE 33: never prompt without user intent).
 */

import type { DisplayMode, InstallState } from "@/lib/pwa/platform";

/**
 * Anonymous "don't ask me again" preference. A cookie, not browser storage:
 * the repository quality gate bans the browser storage APIs in production
 * source, and the locale preference already follows exactly this cookie
 * pattern, so the install opt-out is the one place a new persisted bit
 * appears.
 *
 * The value records *when* the user declined, not just that they did, so a
 * long-dormant visitor can be asked again later. 180 days, matching the
 * locale cookie's one-year order of magnitude but shorter: install
 * willingness decays faster than language preference.
 */
export const INSTALL_DISMISS_COOKIE = "aurora-install-dismissed";

export const INSTALL_DISMISS_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export interface InstallStateInput {
  /** Display mode the browser currently reports. */
  displayMode: DisplayMode;
  /** This platform can ever fire `beforeinstallprompt`. */
  canPrompt: boolean;
  /** An unused, live deferred prompt is being held right now. */
  promptAvailable: boolean;
  /** The user declined during this page session. */
  dismissedThisSession: boolean;
  /** The user declined previously (cookie). */
  persistedDismissed: boolean;
}

/**
 * Classifies the runtime into exactly one state. Order matters: a user who
 * has already installed Aurora outranks everything (there is nothing to
 * offer), and a recorded "not now" outranks a still-valid prompt, because
 * re-offering a prompt the user just refused is the exact behaviour RULE 33
 * prohibits.
 *
 * `unknown` means "eligible, but the browser has not yet decided" — Chrome
 * only fires `beforeinstallprompt` once its own engagement heuristics are
 * satisfied, so a brand-new visitor legitimately sits here. Nothing is
 * rendered in that state; the UI waits rather than showing a control that
 * might never work.
 */
export function deriveInstallState(input: InstallStateInput): InstallState {
  if (input.displayMode !== "browser") {
    return "installed";
  }
  if (input.dismissedThisSession || input.persistedDismissed) {
    return "dismissed";
  }
  if (input.promptAvailable) {
    return "installable";
  }
  return input.canPrompt ? "unknown" : "manual-instructions";
}

/**
 * Whether any install affordance should be on screen. `installed` has
 * nothing to offer and `dismissed`/`unknown` are opt-outs, so only the two
 * actionable states render. A user must therefore never be able to tap an
 * install control and receive a dead interaction (RULE 64).
 */
export function shouldShowInstallAffordance(state: InstallState): boolean {
  return state === "installable" || state === "manual-instructions";
}

/**
 * The sub-shape the component needs to expose, derived once so every
 * consumer agrees on which of the two offers it is (RULE 32/34: a
 * "manual-instructions" affordance must never render an Install button,
 * because that platform has no native prompt to call).
 */
export function installAffordanceKind(
  state: InstallState,
): "none" | "prompt" | "instructions" {
  if (state === "installable") {
    return "prompt";
  }
  if (state === "manual-instructions") {
    return "instructions";
  }
  return "none";
}
