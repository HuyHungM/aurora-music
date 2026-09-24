"use client";

import { useEffect } from "react";

type ServiceWorkerContainer = {
  register(url: string): Promise<unknown>;
};

/**
 * Registers the application-shell service worker exactly once per page
 * load, after load, off the critical path. Owned by the ROOT layout so it
 * survives route transitions and stays independent of PlayerHost (the
 * worker must never be coupled to playback lifecycle).
 *
 * Failure-tolerant by design: unsupported browsers skip silently and a
 * failed registration never affects the application.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return undefined;
    }
    const container = (
      navigator as Navigator & { serviceWorker?: ServiceWorkerContainer }
    ).serviceWorker;
    if (!container || typeof container.register !== "function") {
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const register = () => {
      if (cancelled) {
        return;
      }
      container.register("/sw.js").catch(() => undefined);
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
  return null;
}
