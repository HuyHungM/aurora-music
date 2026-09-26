/**
 * Locale foundation (Phase 42). Vietnamese is the canonical default;
 * English is the only additional supported locale. Client-safe: no
 * Node APIs, no browser APIs (cookie I/O lives at the call sites so
 * SSR and tests stay deterministic).
 */

export const LOCALES = ["vi", "en"] as const;

export type Locale = (typeof LOCALES)[number];

/** Canonical default: first-run experience is always Vietnamese. */
export const DEFAULT_LOCALE: Locale = "vi";

/** Anonymous preference cookie (a cookie, not browser storage: banned by gates). */
export const LOCALE_COOKIE = "aurora-locale";

export function isLocale(value: unknown): value is Locale {
  return value === "vi" || value === "en";
}

/** Coerce unknown input to a supported locale, falling back to Vietnamese. */
export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Human names are never translated into something ambiguous. */
export const LOCALE_NAMES: Record<Locale, string> = {
  vi: "Tiếng Việt",
  en: "English",
};

/** BCP 47 tags for Intl APIs. */
export const LOCALE_TAGS: Record<Locale, string> = {
  vi: "vi-VN",
  en: "en-US",
};
