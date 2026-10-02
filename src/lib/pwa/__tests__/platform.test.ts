import { describe, expect, it } from "vitest";

import {
  detectCapabilities,
  detectPlatform,
  hasWindowControlsOverlay,
  isStandaloneDisplay,
  resolveDisplayMode,
  supportsNativeInstallPrompt,
  toRuntimeMode,
  type PlatformWindow,
} from "@/lib/pwa/platform";

/** A `window` stub whose matchMedia answers from a set of matching queries. */
function fakeWindow(
  matching: readonly string[],
  overrides: Partial<PlatformWindow> = {},
): PlatformWindow {
  return {
    matchMedia: (query: string) => ({ matches: matching.includes(query) }),
    ...overrides,
  } as PlatformWindow;
}

function noMatchMedia(): PlatformWindow {
  return {} as PlatformWindow;
}

describe("display mode detection", () => {
  it("reports the mode the browser actually matches", () => {
    expect(resolveDisplayMode(fakeWindow(["(display-mode: standalone)"]))).toBe(
      "standalone",
    );
    expect(
      resolveDisplayMode(fakeWindow(["(display-mode: minimal-ui)"])),
    ).toBe("minimal-ui");
    expect(
      resolveDisplayMode(fakeWindow(["(display-mode: fullscreen)"])),
    ).toBe("fullscreen");
  });

  it("prefers the richest mode when several match", () => {
    // RULE 30: a single, ordered answer, so every component agrees.
    expect(
      resolveDisplayMode(
        fakeWindow([
          "(display-mode: browser)",
          "(display-mode: standalone)",
          "(display-mode: minimal-ui)",
        ]),
      ),
    ).toBe("standalone");
  });

  it("falls back to browser for absent, throwing, or unknown modes", () => {
    expect(resolveDisplayMode(noMatchMedia())).toBe("browser");
    // A future mode (`window-controls-overlay`) must not be mistaken for an
    // installed app on its own.
    expect(
      resolveDisplayMode(fakeWindow(["(display-mode: window-controls-overlay)"])),
    ).toBe("browser");
    const throwing = {
      matchMedia: () => {
        throw new Error("unsupported");
      },
    } as unknown as PlatformWindow;
    expect(resolveDisplayMode(throwing)).toBe("browser");
  });

  it("classifies runtime mode from the display mode", () => {
    expect(toRuntimeMode("browser")).toBe("browser");
    expect(toRuntimeMode("standalone")).toBe("installed");
    expect(toRuntimeMode("minimal-ui")).toBe("installed");
    expect(toRuntimeMode("fullscreen")).toBe("installed");
    expect(isStandaloneDisplay("browser")).toBe(false);
    expect(isStandaloneDisplay("standalone")).toBe(true);
  });
});

describe("platform identity", () => {
  it("always reports web, never a native shell", () => {
    // RULE 50 / RULE 84: Aurora has no native app. Claiming otherwise would
    // be a lie the platform layer cannot back up.
    expect(detectPlatform()).toBe("web");
  });
});

describe("window controls overlay", () => {
  it("is reported only when the browser matches the mode", () => {
    expect(
      hasWindowControlsOverlay(
        fakeWindow(["(display-mode: window-controls-overlay)"]),
      ),
    ).toBe(true);
    expect(hasWindowControlsOverlay(fakeWindow(["(display-mode: standalone)"]))).toBe(
      false,
    );
    expect(hasWindowControlsOverlay(noMatchMedia())).toBe(false);
  });
});

describe("capability detection", () => {
  it("measures features instead of assuming them", () => {
    const view = fakeWindow(["(display-mode: browser)"], {
      navigator: {
        mediaSession: {},
        share: () => undefined,
        clipboard: {},
        serviceWorker: { controller: {} },
      },
      Notification: function Notification() {
        return undefined;
      },
    });
    // Grant notification permission through the navigator stub.
    (view.navigator as { notificationPermission?: string }).notificationPermission =
      "granted";

    const capabilities = detectCapabilities(view, "browser");
    expect(capabilities.mediaSession).toBe(true);
    expect(capabilities.webShare).toBe(true);
    expect(capabilities.clipboard).toBe(true);
    expect(capabilities.notifications).toBe(true);
    expect(capabilities.standaloneMode).toBe(false);
    expect(capabilities.serviceWorkerControlled).toBe(true);
  });

  it("reports nothing when there is no window", () => {
    const capabilities = detectCapabilities(null, "browser");
    expect(capabilities.mediaSession).toBe(false);
    expect(capabilities.webShare).toBe(false);
    expect(capabilities.notifications).toBe(false);
    expect(capabilities.pushNotifications).toBe(false);
  });

  it("reports local-file playback only where the File System Access API exists", () => {
    // This capability answers "can this browser read a folder the user
    // grants it", NOT "does Aurora download provider audio". That remains
    // forbidden (RULE 54, RULE 76) and is asserted separately against the
    // server contract in `api/app-config`.
    const chromium = detectCapabilities(
      fakeWindow([], {
        navigator: {
          serviceWorker: { controller: {} },
          showDirectoryPicker: () => undefined,
        },
      }),
      "standalone",
    );
    expect(chromium.offlineAudio).toBe(true);

    // Firefox and Safari: honest false, so /offline can show copy rather than
    // a button that cannot work (RULE 34).
    const firefox = detectCapabilities(
      fakeWindow([], { navigator: { serviceWorker: { controller: {} } } }),
      "standalone",
    );
    expect(firefox.offlineAudio).toBe(false);
  });

  it("reports standalone mode from the display mode", () => {
    const view = fakeWindow(["(display-mode: standalone)"]);
    expect(detectCapabilities(view, "standalone").standaloneMode).toBe(true);
  });
});

describe("native install prompt support", () => {
  it("is true on chromium platforms", () => {
    const view = {
      navigator: {
        userAgentData: { platform: "Windows" },
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      },
    } as unknown as PlatformWindow;
    expect(supportsNativeInstallPrompt(view)).toBe(true);
  });

  it("is false on iOS and iPadOS, which have no beforeinstallprompt", () => {
    // RULE 31 / RULE 34: these must be classified up front so the UI offers
    // Share -> Add to Home Screen instructions rather than a dead button.
    const iphone = {
      navigator: {
        userAgentData: { platform: "iOS" },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
      },
    } as unknown as PlatformWindow;
    expect(supportsNativeInstallPrompt(iphone)).toBe(false);
  });

  it("is false for an iPad reporting a desktop user agent", () => {
    // The desktop-mode iPad is the classic false negative: it claims macOS
    // but still has no install prompt. Both signals are required.
    const ipad = {
      navigator: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        maxTouchPoints: 5,
      },
    } as unknown as PlatformWindow;
    expect(supportsNativeInstallPrompt(ipad)).toBe(false);
  });

  it("is false when there is no navigator at all", () => {
    expect(supportsNativeInstallPrompt(null)).toBe(false);
    expect(supportsNativeInstallPrompt({} as PlatformWindow)).toBe(false);
  });
});
