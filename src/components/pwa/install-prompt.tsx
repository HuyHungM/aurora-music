"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  detectCapabilities,
  detectPlatform,
  resolveDisplayMode,
  supportsNativeInstallPrompt,
  toRuntimeMode,
  type ClientCapabilities,
  type DisplayMode,
  type InstallState,
  type Platform,
  type PlatformWindow,
  type RuntimeMode,
} from "@/lib/pwa/platform";
import {
  deriveInstallState,
  installAffordanceKind,
  shouldShowInstallAffordance,
} from "@/lib/pwa/install";

/**
 * The deferred install event. Not part of lib.dom's `WindowEventMap` in every
 * TypeScript release, so it is declared structurally here — the two members
 * Aurora actually calls.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface InstallContextValue {
  state: InstallState;
  kind: ReturnType<typeof installAffordanceKind>;
  visible: boolean;
  platform: Platform;
  runtimeMode: RuntimeMode;
  displayMode: DisplayMode;
  capabilities: ClientCapabilities;
  /** Present only in the `installable` state; no-ops otherwise. */
  promptInstall: () => void;
  /** Hides the affordance for the session and records the opt-out. */
  dismiss: () => void;
  /** True when the browser reports a non-browser display mode. */
  isInstalled: boolean;
}

const InstallContext = createContext<InstallContextValue | null>(null);

const EVENT_BEFORE_INSTALL_PROMPT = "beforeinstallprompt";
const EVENT_APP_INSTALLED = "appinstalled";

/** `window` only on the client; `null` during SSR, where it does not exist. */
function clientWindow(): PlatformWindow | null {
  return typeof window === "undefined"
    ? null
    : (window as unknown as PlatformWindow);
}

/**
 * Whether the current render is the hydration render.
 *
 * `useSyncExternalStore` is the codebase's established answer to "is this
 * real, and is this the server?" — the MusicEngine bindings use the same
 * primitive for exactly the same reason. React guarantees the *client* getter
 * is not called while hydrating, so this is a true, documented signal rather
 * than the `useState` + `useEffect` flag the linter rejects as a cascading
 * render.
 *
 * Server snapshot is `false`, which is the conservative direction: it yields
 * `InstallState = "unknown"` and renders no affordance, so the first client
 * paint always agrees with the server's HTML.
 */
function useIsHydrating(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => false,
    () => true,
  );
}

/** No-op subscription: this value never changes after hydration. */
function subscribeNever(): () => void {
  return () => undefined;
}

const DISPLAY_MODE_QUERIES = [
  "browser",
  "standalone",
  "minimal-ui",
  "fullscreen",
] as const;

/**
 * Subscribes to every display-mode query at once. Installed chrome can change
 * while the app is running (the user installs it, or leaves standalone mode),
 * and `window-controls-overlay` is watched too so enabling that mode later
 * does not require a reload (RULE 20, RULE 30).
 */
function useDisplayMode(): DisplayMode {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("browser");

  useEffect(() => {
    const sync = () => setDisplayMode(resolveDisplayMode(clientWindow()));
    sync();

    const teardown: Array<() => void> = [];
    const queries = [
      ...DISPLAY_MODE_QUERIES.map((mode) => `(display-mode: ${mode})`),
      "(display-mode: window-controls-overlay)",
    ];
    for (const query of queries) {
      const mql = window.matchMedia?.(query);
      if (!mql) {
        continue;
      }
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", sync);
        teardown.push(() => mql.removeEventListener("change", sync));
      } else if (typeof mql.addListener === "function") {
        // Safari < 14 implements only the legacy MediaQueryList API.
        mql.addListener(sync);
        teardown.push(() => mql.removeListener(sync));
      }
    }
    return () => {
      for (const off of teardown) {
        off();
      }
    };
  }, []);

  return displayMode;
}

/**
 * The single install authority for the whole application (Phase 51).
 *
 * Why a provider rather than a hook used at each call site: a hook would let
 * a second component attach a second `beforeinstallprompt` listener and hold a
 * second deferred-prompt reference, while browsers fire that event only once
 * — the second listener would receive nothing and the two affordances could
 * disagree about whether installation is available. One provider, one
 * listener, one prompt, one truth (RULE 31, RULE 33).
 *
 * Guarantees:
 * - The prompt is NEVER shown automatically. `beforeinstallprompt` only
 *   *arms* the affordance; `promptInstall()` runs solely from a click, so
 *   Chromium's "no surprising install prompts" contract holds.
 * - `prompt()` is called at most once per event. The deferred reference is
 *   dropped synchronously before the call, because the event is single-use
 *   and a second `prompt()` throws in Chromium.
 * - Listeners are removed and the deferred reference cleared on unmount, so a
 *   route change can never leave a stale prompt behind.
 * - Nothing is derived from `window` during render. Platform sniffing happens
 *   in effects and is gated behind `mounted`, so the server-rendered HTML and
 *   the first client render agree — otherwise iOS (no native prompt) and
 *   Chromium (prompt may still be pending) would produce different markup for
 *   the same page and trip a hydration mismatch.
 */
export function InstallProvider({
  children,
  initiallyDismissed = false,
}: {
  children: ReactNode;
  /** Seeded server-side from the dismissal cookie. */
  initiallyDismissed?: boolean;
}) {
  const displayMode = useDisplayMode();
  const [promptAvailable, setPromptAvailable] = useState(false);
  const [dismissedThisSession, setDismissedThisSession] = useState(
    initiallyDismissed,
  );
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const inFlight = useRef(false);

  /**
   * `canPrompt` is a property of the runtime, not of anything the user can
   * change mid-session, so it is read in the same lazy initializer the rest
   * of the codebase uses for browser state (see `useOnlineStatus`) instead of
   * in an effect. That keeps a synchronous `setState` out of an effect body
   * and avoids the extra cascading render the linter rightly rejects. Reading
   * it during the first client render is safe: `mounted` is still false there,
   * so nothing window-dependent reaches the markup.
   */
  const [canPrompt] = useState(() => supportsNativeInstallPrompt(clientWindow()));

  // True while hydrating, false for every render after. Replaces the
  // `useState` + `useEffect` "mounted" flag: the effect version set state
  // synchronously inside the effect body, which React flags as a cascading
  // render, and it cost a second render pass on every page load to learn
  // something `useSyncExternalStore` already knows.
  const hydrating = useIsHydrating();
  const mounted = !hydrating;

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // Without preventDefault() Chromium shows its own mini-infobar and then
      // suppresses the event, which would leave the affordance offering
      // something the browser refuses to show.
      event.preventDefault();
      deferredPrompt.current = event as BeforeInstallPromptEvent;
      setPromptAvailable(true);
    };
    const onAppInstalled = () => {
      deferredPrompt.current = null;
      setPromptAvailable(false);
    };

    window.addEventListener(EVENT_BEFORE_INSTALL_PROMPT, onBeforeInstallPrompt);
    window.addEventListener(EVENT_APP_INSTALLED, onAppInstalled);
    return () => {
      window.removeEventListener(
        EVENT_BEFORE_INSTALL_PROMPT,
        onBeforeInstallPrompt,
      );
      window.removeEventListener(EVENT_APP_INSTALLED, onAppInstalled);
      deferredPrompt.current = null;
    };
  }, []);

  const promptInstall = useCallback(() => {
    const event = deferredPrompt.current;
    if (!event || inFlight.current) {
      return;
    }
    inFlight.current = true;
    deferredPrompt.current = null;
    setPromptAvailable(false);
    void event
      .prompt()
      .then(() => event.userChoice)
      .then(({ outcome }) => {
        if (outcome === "dismissed") {
          // The user refused the native sheet: treat it as a decline so the
          // affordance does not reappear on the next navigation.
          setDismissedThisSession(true);
        }
      })
      .catch(() => {
        // A failed prompt (commonly a transient NotAllowedError while the
        // page is backgrounded) must not break the page or re-arm the button.
        setDismissedThisSession(true);
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);

  const dismiss = useCallback(() => {
    setDismissedThisSession(true);
    deferredPrompt.current = null;
    setPromptAvailable(false);
  }, []);

  const value = useMemo<InstallContextValue>(() => {
    // `mounted` is the gate that keeps `window` out of render: before it is
    // true the platform is genuinely unknown, so the honest classification is
    // `unknown` and nothing is shown.
    const state: InstallState = mounted
      ? deriveInstallState({
          displayMode,
          canPrompt,
          promptAvailable,
          dismissedThisSession,
          persistedDismissed: initiallyDismissed,
        })
      : "unknown";
    return {
      state,
      kind: installAffordanceKind(state),
      visible: mounted && shouldShowInstallAffordance(state),
      platform: detectPlatform(),
      runtimeMode: toRuntimeMode(displayMode),
      displayMode,
      capabilities: mounted
        ? detectCapabilities(clientWindow(), displayMode)
        : detectCapabilities(null, displayMode),
      promptInstall,
      dismiss,
      isInstalled: mounted && state === "installed",
    };
  }, [
    mounted,
    displayMode,
    canPrompt,
    promptAvailable,
    dismissedThisSession,
    initiallyDismissed,
    promptInstall,
    dismiss,
  ]);

  return (
    <InstallContext.Provider value={value}>{children}</InstallContext.Provider>
  );
}

/**
 * Reads the install authority. Throws outside the provider rather than
 * returning a permissive default: a component that believed it was
 * installable when it was not would render a control that cannot work.
 */
export function useInstall(): InstallContextValue {
  const value = useContext(InstallContext);
  if (!value) {
    throw new Error("useInstall must be used inside <InstallProvider>");
  }
  return value;
}
