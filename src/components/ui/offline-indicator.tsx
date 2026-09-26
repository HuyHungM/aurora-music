"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/components/i18n/locale-provider";

/**
 * Minimal online/offline state (Phase 21). Event-driven only: no polling,
 * no timers, no network probes. SSR-safe (assumes online until mounted),
 * StrictMode-safe (symmetric subscribe/unsubscribe), and strictly local
 * state — network events never rerender the player or mutate playback.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return true;
    }
    return navigator.onLine !== false;
  });

  useEffect(() => {
    const sync = () => {
      if (typeof navigator !== "undefined") {
        setOnline(navigator.onLine !== false);
      }
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return online;
}

/**
 * Subtle application-level offline indicator. Rendered only while offline;
 * hides itself on reconnect without touching playback, queue, or recovery.
 */
export function OfflineIndicator() {
  const online = useOnlineStatus();
  const { t } = useLocale();
  if (online) {
    return null;
  }
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-[calc(0.75rem+env(safe-area-inset-top))] z-toast mx-auto w-max max-w-[90%] rounded-full border border-border-subtle bg-surface-1 px-4 py-1.5 text-xs text-text-secondary shadow-lg"
    >
      {t("offline.message")}
    </div>
  );
}
