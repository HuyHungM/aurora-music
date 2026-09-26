import type { Locale } from "./locale";
import { DEFAULT_LOCALE, LOCALES, LOCALE_TAGS } from "./locale";
import vi, { type Messages } from "./vi";
import en from "./en";

export type { Messages };

const DICTIONARIES: Record<Locale, Messages> = { vi, en };

/** All supported dictionaries (used by the parity test). */
export function getDictionaries(): Record<Locale, Messages> {
  return DICTIONARIES;
}

export type MessageKey = string;

function lookup(messages: Messages, key: string): unknown {
  let current: unknown = messages;
  for (const part of key.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate a dotted key. Falls back to Vietnamese, then to the key
 * itself (a visible, deterministic marker — parity tests fail CI long
 * before a missing key ships silently).
 */
export function t(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const primary = lookup(DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE], key);
  if (typeof primary === "string") {
    return interpolate(primary, params);
  }
  if (locale !== DEFAULT_LOCALE) {
    const fallback = lookup(DICTIONARIES[DEFAULT_LOCALE], key);
    if (typeof fallback === "string") {
      return interpolate(fallback, params);
    }
  }
  return key;
}

/** Bound translator for a fixed locale (server components, presenters). */
export function getT(locale: Locale) {
  return (key: MessageKey, params?: Record<string, string | number>): string =>
    t(locale, key, params);
}

/** Locale-aware plural selection via Intl.PluralRules (no manual "s"). */
export function plural(
  locale: Locale,
  count: number,
  forms: { one: string; other: string },
  params?: Record<string, string | number>,
): string {
  const rule = new Intl.PluralRules(LOCALE_TAGS[locale]).select(count);
  const template = rule === "one" ? forms.one : forms.other;
  return interpolate(template, { count, ...params });
}

/** Locale-aware calendar date, e.g. "25 tháng 9, 2026" / "September 25, 2026". */
export function formatDate(locale: Locale, value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** Locale-aware number, e.g. track/playlist counts. */
export function formatNumber(locale: Locale, value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return new Intl.NumberFormat(LOCALE_TAGS[locale]).format(value);
}

/** True when every locale dictionary exposes exactly the same key set. */
export function dictionaryKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  const keys: string[] = [];
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix.length > 0 ? `${prefix}.${name}` : name;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      keys.push(...dictionaryKeys(child, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

export { LOCALES };
