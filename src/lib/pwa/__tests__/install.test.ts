import { describe, expect, it } from "vitest";

import {
  INSTALL_DISMISS_COOKIE,
  INSTALL_DISMISS_MAX_AGE_SECONDS,
  deriveInstallState,
  installAffordanceKind,
  shouldShowInstallAffordance,
  type InstallStateInput,
} from "@/lib/pwa/install";

const BASE: InstallStateInput = {
  displayMode: "browser",
  canPrompt: true,
  promptAvailable: false,
  dismissedThisSession: false,
  persistedDismissed: false,
};

describe("install state machine", () => {
  it("offers nothing once the app is installed", () => {
    // RULE 31: "installed" outranks every other state, in any display mode
    // that means windowed-without-browser-chrome.
    for (const displayMode of ["standalone", "minimal-ui", "fullscreen"] as const) {
      const state = deriveInstallState({ ...BASE, displayMode, promptAvailable: true });
      expect(state).toBe("installed");
      expect(shouldShowInstallAffordance(state)).toBe(false);
    }
  });

  it("offers the native prompt when the browser supplied one", () => {
    const state = deriveInstallState({ ...BASE, promptAvailable: true });
    expect(state).toBe("installable");
    expect(installAffordanceKind(state)).toBe("prompt");
    expect(shouldShowInstallAffordance(state)).toBe(true);
  });

  it("falls back to manual instructions where no prompt can ever fire", () => {
    // RULE 34: iOS. Never a button that does nothing.
    const state = deriveInstallState({ ...BASE, canPrompt: false });
    expect(state).toBe("manual-instructions");
    expect(installAffordanceKind(state)).toBe("instructions");
  });

  it("stays silent while the browser has not yet decided", () => {
    // Chrome only fires beforeinstallprompt once its own engagement
    // heuristics pass, so a first-run visitor legitimately sits here.
    const state = deriveInstallState(BASE);
    expect(state).toBe("unknown");
    expect(shouldShowInstallAffordance(state)).toBe(false);
    expect(installAffordanceKind(state)).toBe("none");
  });

  it("respects a session or persisted decline over a live prompt", () => {
    // RULE 33: re-offering a prompt the user just refused is the exact
    // behaviour that must not happen.
    const session = deriveInstallState({
      ...BASE,
      promptAvailable: true,
      dismissedThisSession: true,
    });
    expect(session).toBe("dismissed");
    expect(shouldShowInstallAffordance(session)).toBe(false);

    const persisted = deriveInstallState({
      ...BASE,
      promptAvailable: true,
      persistedDismissed: true,
    });
    expect(persisted).toBe("dismissed");
  });

  it("never offers a button on a platform that cannot prompt", () => {
    // RULE 64: a user must never click an install control into a dead
    // interaction. With no platform prompt and none held, the only truthful
    // affordance is the manual instruction, so `prompt` is unreachable.
    const state = deriveInstallState({ ...BASE, canPrompt: false, promptAvailable: false });
    expect(state).toBe("manual-instructions");
    expect(installAffordanceKind(state)).toBe("instructions");

    // The converse: a genuinely held deferred prompt is always preferred over
    // instructions, because pressing it really does install the app. On iOS
    // this combination cannot occur — `beforeinstallprompt` never fires there
    // — so the rule is safe rather than aspirational.
    const withPrompt = deriveInstallState({
      ...BASE,
      canPrompt: false,
      promptAvailable: true,
    });
    expect(withPrompt).toBe("installable");
    expect(installAffordanceKind(withPrompt)).toBe("prompt");
  });

  it("keeps the dismissal opt-out anonymous and bounded", () => {
    // RULE 55: this is a UI-suppression bit, not user data.
    expect(INSTALL_DISMISS_COOKIE).toBe("aurora-install-dismissed");
    expect(INSTALL_DISMISS_MAX_AGE_SECONDS).toBeGreaterThan(0);
    // Shorter than the locale cookie's year: install willingness decays.
    expect(INSTALL_DISMISS_MAX_AGE_SECONDS).toBeLessThanOrEqual(60 * 60 * 24 * 365);
  });
});
