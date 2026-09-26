"use client";

import { useEffect } from "react";
import {
  ACTIVATE_MESSAGE,
  LOCALE_MESSAGE,
  SERVICE_WORKER_URL,
  releaseStaleDevelopmentWorkers,
  shouldRegisterServiceWorker,
} from "@/lib/pwa/service-worker";
import { useLocale } from "@/components/i18n/locale-provider";

type ServiceWorkerContainer = {
  register(url: string): Promise<unknown>;
  getRegistrations?(): Promise<
    Array<{
      unregister(): Promise<boolean>;
      readonly active: { scriptURL: string } | null;
      readonly waiting: { scriptURL: string } | null;
      readonly installing: { scriptURL: string } | null;
    }>
  >;
};

/**
 * Registers the application-shell service worker exactly once per page
 * load, after load, off the critical path. Owned by the ROOT layout so it
 * survives route transitions and stays independent of PlayerHost (the
 * worker must never be coupled to playback lifecycle).
 *
 * Environment isolation: registration is production-only. Under `next dev`
 * (Turbopack) `/_next/static/*` serves the live module graph, so a
 * cache-first worker would serve stale chunks and break the runtime with
 * module-factory errors. Development sessions therefore never register;
 * instead they release any stale Aurora worker left over from an earlier
 * session so it cannot silently control the dev page.
 *
 * Failure-tolerant by design: unsupported browsers skip silently and a
 * failed registration (or release) never affects the application.
 */
export function ServiceWorkerRegister() {
  const { locale } = useLocale();

  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return undefined;
    }
    const container = (
      navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }
    ).serviceWorker;
    if (!container) {
      return undefined;
    }
    if (!shouldRegisterServiceWorker()) {
      void releaseStaleDevelopmentWorkers(container);
      return undefined;
    }
    if (typeof container.register !== "function") {
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const register = () => {
      if (cancelled) {
        return;
      }
      container.register(SERVICE_WORKER_URL).catch(() => undefined);
    };
    if (document.readyState === "complete") {
      timer = setTimeout(register, 1);
    } else {
      const onLoad = () => {
        timer = setTimeout(register, 1);
      };
      window.addEventListener("load", onLoad, { once: true });
      return () => {
        cancelled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        window.removeEventListener("load", onLoad);
      };
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, []);

  /**
   * Safe update hand-over (Phase 51). The worker deliberately does not skip
   * waiting on install, so a new build parks until the page releases it.
   *
   * The release point is `pagehide` — the current document is leaving, so
   * activating cannot re-parent a running page onto a different build and
   * cannot disturb playback. Deliberately decoupled from the player: this
   * component knows nothing about the queue or the transport, and the worker
   * only ever serves hashed static assets, so neither side has to reason
   * about the other's lifecycle.
   *
   * `pagehide` covers tab close, navigation and bfcache eviction — every case
   * where the old document genuinely goes away — so an update is picked up on
   * the next launch rather than after a browser-specific reap interval.
   */
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !shouldRegisterServiceWorker() ||
      !("serviceWorker" in navigator)
    ) {
      return undefined;
    }
    const release = () => {
      void navigator.serviceWorker
        .getRegistration()
        .then((registration) => {
          const waiting = registration?.waiting;
          if (waiting) {
            waiting.postMessage({ type: ACTIVATE_MESSAGE });
          }
        })
        .catch(() => undefined);
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, []);

  /**
   * Tell the worker which language the document is in.
   *
   * The worker's offline page is the only Aurora surface the visitor cannot
   * navigate away from, and it is built with no knowledge of the app. Before
   * this existed it tried to read the `aurora-locale` cookie off the navigation
   * request — which Chromium does not expose to a service worker — so every
   * offline visitor saw the Vietnamese default regardless of the language they
   * had chosen. See `LOCALE_MESSAGE` for the measurement.
   *
   * Posted to `navigator.serviceWorker.controller`, not to the registration:
   * a message to a registration reaches whichever worker is active, whereas the
   * controller is the worker actually serving this document, and the one that
   * will answer the next offline navigation. Before the first page is
   * controlled there is nothing to post to, so the effect also runs on
   * `controllerchange` — a first visit that loses connectivity before the
   * worker takes over still ends up registered.
   *
   * Keyed on `locale`, so switching language re-announces it with no listener
   * bookkeeping. The post is fire-and-forget: a worker that is mid-update or
   * absent must not surface anything to the visitor.
   */
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !shouldRegisterServiceWorker() ||
      !("serviceWorker" in navigator)
    ) {
      return undefined;
    }
    const container = navigator.serviceWorker;
    const announce = () => {
      const controller = container.controller;
      if (!controller) {
        return;
      }
      try {
        controller.postMessage({ type: LOCALE_MESSAGE, locale });
      } catch {
        // A worker that cannot receive messages is not the visitor's problem.
      }
    };
    announce();
    // Feature-detected, not assumed. `ServiceWorkerContainer` is an interface
    // with more surface than every engine implements, and this component's
    // documented contract is that an incomplete implementation is skipped
    // silently rather than thrown from an effect. The `pagehide` hand-over
    // above feature-detects `getRegistration` for the same reason.
    if (typeof container.addEventListener !== "function") {
      return undefined;
    }
    container.addEventListener("controllerchange", announce);
    return () => {
      container.removeEventListener("controllerchange", announce);
    };
  }, [locale]);

  return null;
}
