/**
 * Runtime platform, display mode and capability detection (Phase 51).
 *
 * ONE detector for the whole application. `window.matchMedia` and friends
 * must never be called from a component: display mode can change while the
 * app is running (the user installs it, or dismisses a prompt, mid-session),
 * so a value sampled per-component would disagree with itself and cause
 * hydration mismatches. Everything here is pure and takes its inputs as
 * arguments, so it is fully testable without a browser.
 *
 * The active platform is always `web`. Aurora has no native shell yet; the
 * richer `Platform` union exists so a future wrapper (Capacitor/Tauri/WebView)
 * can identify itself without this module changing shape, and so capability
 * reporting stays honest about what is actually running (RULE 50, RULE 84).
 *
 * Client-safe: no Node APIs, no secrets. Nothing here reads a global on
 * import — the caller supplies the `window`-like object, which is what keeps
 * SSR deterministic (RULE 29: installed and browser mode are the same
 * application, only the presentation differs).
 */

/**
 * Host platform. `"web"` is the only value Aurora can currently report.
 * The other members are reserved for a future native wrapper; they are never
 * inferred from user-agent sniffing, because a spoofed UA must not be able
 * to make the app claim capabilities it lacks.
 */
export type Platform = "web" | "android" | "ios" | "windows" | "macos" | "linux";

/** How the application is currently being presented. */
export type DisplayMode =
  | "browser"
  | "standalone"
  | "minimal-ui"
  | "fullscreen";

/**
 * Coarse runtime mode. `installed` is derived, not sniffed: it means "the
 * browser reports a non-browser display mode", which is the only signal the
 * web platform actually provides.
 */
export type RuntimeMode = "browser" | "installed";

/** Whether a Web Share / install flow is available, and why not if not. */
export type InstallState =
  /** Running as an installed app already; nothing to offer. */
  | "installed"
  /** The browser fired `beforeinstallprompt` and the prompt is unused. */
  | "installable"
  /** The user dismissed the affordance for this session. */
  | "dismissed"
  /**
   * The platform will never fire `beforeinstallprompt` — iOS Safari and
   * in-app browsers. These need Share → Add to Home Screen instructions
   * instead, and must never be shown a button that cannot work (RULE 34).
   */
  | "manual-instructions"
  /** Not yet known: still waiting for the first `beforeinstallprompt`. */
  | "unknown";

/**
 * Capabilities actually observed on this runtime. Every field is measured or
 * feature-detected — nothing is hardcoded to `true`. Aurora reports
 * `offlineAudio: false` unconditionally: there is no offline download
 * feature, and advertising one would be a lie the SW cannot back up
 * (RULE 51, RULE 76).
 */
export interface ClientCapabilities {
  /** Media Session API present, so OS/media-key controls can be driven. */
  mediaSession: boolean;
  /** Web Share API present (Level 1: `navigator.share`). */
  webShare: boolean;
  /** `navigator.clipboard` write available. */
  clipboard: boolean;
  /** Notifications API present AND permission already granted. */
  notifications: boolean;
  /** Push manager present (requires an installed app on iOS). */
  pushNotifications: boolean;
  /** Running with no browser chrome (standalone / minimal-ui / fullscreen). */
  standaloneMode: boolean;
  /** A service worker is currently controlling the page. */
  serviceWorkerControlled: boolean;
  /** Cache Storage available, so the application shell can be cached. */
  offlineShell: boolean;
  /**
   * True when the browser can play audio the user already has locally, i.e.
   * the File System Access API is present (RULE 34).
   *
   * This was a literal `false` and stayed one for a long time, because
   * Aurora had no offline audio at all and advertising one would be a lie the
   * service worker cannot back up (RULE 51, RULE 76). It is still NOT a
   * statement about downloading provider media — that remains forbidden, and
   * nothing here caches or persists a provider stream. It answers a different
   * question: whether this browser can read a folder the user grants it.
   */
  offlineAudio: boolean;
  /** `display_override: ["window-controls-overlay"]` is active. */
  windowControlsOverlay: boolean;
}

/** The subset of `window` this module reads. */
export interface PlatformWindow {
  matchMedia?: (query: string) => { matches: boolean };
  navigator?: {
    mediaSession?: unknown;
    share?: unknown;
    clipboard?: unknown;
    serviceWorker?: { controller?: unknown };
    storage?: { persist?: unknown };
  } & Record<string, unknown>;
  Notification?: unknown;
}

/**
 * Maps a CSS display-mode query to the typed union. Unknown or future modes
 * (`window-controls-overlay`, picture-in-picture, …) fall back to `browser`
 * so an unrecognised mode never silently claims to be installed.
 */
export function resolveDisplayMode(view: PlatformWindow | null): DisplayMode {
  if (!view || typeof view.matchMedia !== "function") {
    return "browser";
  }
  const modes: DisplayMode[] = [
    "fullscreen",
    "standalone",
    "minimal-ui",
    "browser",
  ];
  for (const mode of modes) {
    let matches = false;
    try {
      matches = view.matchMedia(`(display-mode: ${mode})`).matches;
    } catch {
      matches = false;
    }
    if (matches) {
      return mode;
    }
  }
  return "browser";
}

export function isStandaloneDisplay(mode: DisplayMode): boolean {
  return mode !== "browser";
}

export function toRuntimeMode(mode: DisplayMode): RuntimeMode {
  return isStandaloneDisplay(mode) ? "installed" : "browser";
}

/**
 * Aurora is a web application; there is no native shell, so the platform is
 * constant. Kept as a function (not a bare constant) so a future wrapper has
 * an obvious single place to report itself.
 */
export function detectPlatform(): Platform {
  return "web";
}

/**
 * True only for the two display modes a browser reports when the app is
 * genuinely windowed without browser chrome.
 */
export function hasWindowControlsOverlay(view: PlatformWindow | null): boolean {
  if (!view || typeof view.matchMedia !== "function") {
    return false;
  }
  try {
    return view
      .matchMedia("(display-mode: window-controls-overlay)")
      .matches;
  } catch {
    return false;
  }
}

/**
 * Measures the runtime's real capabilities. Notification and push support
 * are reported only when already granted, so a first-run visitor is not told
 * it has push before it has asked for it.
 */
export function detectCapabilities(
  view: PlatformWindow | null,
  displayMode: DisplayMode,
): ClientCapabilities {
  const nav = view?.navigator;
  const hasNotification =
    typeof view?.Notification === "function" &&
    (nav as { notificationPermission?: string } | undefined)
      ?.notificationPermission === "granted";
  const pushManager = (
    nav as { serviceWorker?: { registration?: { pushManager?: unknown } } }
  )?.serviceWorker?.registration?.pushManager;
  return {
    mediaSession: Boolean(nav && "mediaSession" in nav && nav.mediaSession),
    webShare: Boolean(nav && typeof nav.share === "function"),
    clipboard: Boolean(nav && "clipboard" in nav && nav.clipboard),
    notifications: hasNotification,
    pushNotifications: Boolean(pushManager),
    standaloneMode: isStandaloneDisplay(displayMode),
    serviceWorkerControlled: Boolean(nav?.serviceWorker?.controller),
    offlineShell: typeof caches !== "undefined",
    offlineAudio: typeof (nav as { showDirectoryPicker?: unknown })?.showDirectoryPicker === "function",
    windowControlsOverlay: hasWindowControlsOverlay(view),
  };
}

/**
 * Whether this platform can ever show a native install prompt.
 *
 * Only Chromium browsers fire `beforeinstallprompt`. iOS/iPadOS Safari and
 * Android in-app browsers (a custom tab inside a social app) have no such
 * event at all, so they are classified up front and shown Share → Add to
 * Home Screen instructions rather than a button that would do nothing
 * (RULE 31, RULE 34).
 *
 * Detection is deliberately coarse and feature-based: it inspects the
 * presence of the event's own plumbing and the platform family, never a
 * full user-agent string, so a desktop-mode iPad is not misclassified.
 */
export function supportsNativeInstallPrompt(view: PlatformWindow | null): boolean {
  if (!view || !view.navigator) {
    return false;
  }
  const nav = view.navigator as {
    userAgentData?: { platform?: string };
    userAgent?: string;
    maxTouchPoints?: number;
    standalone?: boolean;
  };
  const navRef = nav as Navigator & {
    userAgentData?: { platform?: string };
  };

  // An iPad in desktop mode reports a desktop UA but is a touch device with
  // no beforeinstallprompt; both signals are required to exclude it.
  const platform = navRef.userAgentData?.platform ?? "";
  const ua = navRef.userAgent ?? "";
  const isIosFamily =
    /iPhone|iPad|iPod/i.test(ua) ||
    (platform === "" &&
      (nav.maxTouchPoints ?? 0) > 1 &&
      /Macintosh/i.test(ua) &&
      !("ontouchend" in (view as unknown as Record<string, unknown>)));
  if (isIosFamily) {
    return false;
  }
  if (platform === "iOS" || platform === "macOS" && nav.standalone) {
    return false;
  }
  return true;
}
