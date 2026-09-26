"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  resolveLocale,
  type Locale,
} from "@/lib/i18n/locale";
import { getT } from "@/lib/i18n/translate";
import { setLocaleAction } from "@/app/actions/locale";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: ReturnType<typeof getT>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Application locale state (Phase 42). Seeded from the server-resolved
 * locale (no hydration mismatch: first render matches SSR). Switching
 * updates instantly, writes the cookie synchronously, persists via the
 * server action, then refreshes server-rendered parts — no reload, no
 * remount. Playback engines never consume this context, so switching
 * cannot interrupt music, reset the queue, or recreate players.
 */
export function LocaleProvider({
  initialLocale,
  children,
}: {
  initialLocale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() =>
    resolveLocale(initialLocale),
  );
  const [, startTransition] = useTransition();
  const router = useRouter();

  const setLocale = useCallback(
    (next: Locale) => {
      const resolved = resolveLocale(next);
      setLocaleState(resolved);
      try {
        document.cookie = `${LOCALE_COOKIE}=${resolved}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
      } catch {
        // Cookie write is best-effort; server action still persists.
      }
      startTransition(async () => {
        try {
          await setLocaleAction(resolved);
        } catch {
          // Display already updated; persistence retries on next change.
        }
        router.refresh();
      });
    },
    [router],
  );

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: getT(locale) }),
    [locale, setLocale],
  );

  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

const FALLBACK_VALUE: LocaleContextValue = {
  locale: DEFAULT_LOCALE,
  // No-op outside a provider (isolated unit tests, static prerender
  // edges): display stays on the Vietnamese default, persistence is
  // simply unavailable.
  setLocale: () => undefined,
  t: getT(DEFAULT_LOCALE),
};

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext) ?? FALLBACK_VALUE;
}
