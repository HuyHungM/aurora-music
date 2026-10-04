import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_NAMES,
  LOCALE_TAGS,
  isLocale,
  resolveLocale,
} from "@/lib/i18n/locale";
import {
  dictionaryKeys,
  formatDate,
  formatNumber,
  getDictionaries,
  plural,
  t,
} from "@/lib/i18n/translate";

describe("locale defaults", () => {
  it("defaults to Vietnamese", () => {
    expect(DEFAULT_LOCALE).toBe("vi");
  });

  it("supports exactly vi and en", () => {
    expect([...LOCALES]).toEqual(["vi", "en"]);
  });

  it("uses full language names, never bare codes", () => {
    expect(LOCALE_NAMES.vi).toBe("Tiếng Việt");
    expect(LOCALE_NAMES.en).toBe("English");
  });

  it("coerces unknown input to the Vietnamese default", () => {
    expect(resolveLocale("fr")).toBe("vi");
    expect(resolveLocale("ja")).toBe("vi");
    expect(resolveLocale(null)).toBe("vi");
    expect(resolveLocale(undefined)).toBe("vi");
    expect(resolveLocale("")).toBe("vi");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("vi")).toBe("vi");
  });

  it("validates supported locales", () => {
    expect(isLocale("vi")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("es")).toBe(false);
  });
});

describe("translation coverage", () => {
  it("has exact key parity across all supported locales", () => {
    const dicts = getDictionaries();
    const viKeys = dictionaryKeys(dicts.vi);
    const enKeys = dictionaryKeys(dicts.en);
    expect(enKeys).toEqual(viKeys);
    expect(viKeys.length).toBeGreaterThan(0);
  });

  it("interpolates named params without concatenation", () => {
    expect(t("vi", "home.greetingMorning", { name: "An" })).toBe(
      "Chào buổi sáng, An",
    );
    expect(t("en", "home.greetingMorning", { name: "An" })).toBe(
      "Good morning, An",
    );
    expect(t("vi", "playlist.addedToTitle", { title: "Mix" })).toBe(
      "Đã thêm vào “Mix”",
    );
  });

  it("leaves unknown placeholders intact", () => {
    expect(t("vi", "home.greetingMorning")).toContain("{name}");
  });

  it("returns the key for missing entries", () => {
    expect(t("en", "non.existent.key")).toBe("non.existent.key");
  });

  it("falls back to Vietnamese when English lacks a key", () => {
    const dicts = getDictionaries();
    const backup = dicts.en.common.cancel;
    // @ts-expect-error deliberate gap for the fallback path
    delete dicts.en.common.cancel;
    try {
      expect(t("en", "common.cancel")).toBe(dicts.vi.common.cancel);
    } finally {
      dicts.en.common.cancel = backup;
    }
  });

  it("keeps placeholder sets identical across locales for every key", () => {
    // A placeholder present in one locale and missing in the other renders
    // either a raw `{name}` or a silently dropped value — a mixed-language
    // sentence either way. Compared as sets, so reordering placeholders is
    // free (Vietnamese word order differs) but adding/dropping one fails.
    const dicts = getDictionaries();
    const names = (template: string): string[] => {
      const out = new Set<string>();
      for (const m of template.matchAll(/\{(\w+)\}/g)) out.add(m[1]);
      return [...out].sort();
    };
    const viKeys = dictionaryKeys(dicts.vi);
    const offenders: string[] = [];
    for (const key of viKeys) {
      const parts = key.split(".");
      let viNode: unknown = dicts.vi;
      let enNode: unknown = dicts.en;
      for (const part of parts) {
        viNode = (viNode as Record<string, unknown>)[part];
        enNode = (enNode as Record<string, unknown>)[part];
      }
      if (typeof viNode === "string" && typeof enNode === "string") {
        const viNames = JSON.stringify(names(viNode));
        const enNames = JSON.stringify(names(enNode));
        if (viNames !== enNames) offenders.push(`${key}: vi=${viNames} en=${enNames}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses the typographic ellipsis in pending states, never three dots", () => {
    // ASCII "..." beside "…" is a second way to write the same pause, and
    // the two render at different widths. Pending states (loading, saving,
    // generating) are the only strings allowed to trail off at all, and
    // every one of them uses U+2026.
    const dicts = getDictionaries();
    const offenders: string[] = [];
    for (const key of dictionaryKeys(dicts.vi)) {
      for (const dict of [dicts.vi, dicts.en] as const) {
        let node: unknown = dict;
        for (const part of key.split(".")) {
          node = (node as Record<string, unknown>)[part];
        }
        if (typeof node === "string" && node.includes("...")) {
          offenders.push(key);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("pluralization", () => {
  it("selects forms via Intl.PluralRules, never manual suffixing", () => {
    expect(plural("en", 1, { one: "{count} track", other: "{count} tracks" })).toBe(
      "1 track",
    );
    expect(plural("en", 2, { one: "{count} track", other: "{count} tracks" })).toBe(
      "2 tracks",
    );
    expect(plural("vi", 1, { one: "{count} bài hát", other: "{count} bài hát" })).toBe(
      "1 bài hát",
    );
    expect(plural("vi", 2, { one: "{count} bài hát", other: "{count} bài hát" })).toBe(
      "2 bài hát",
    );
  });
});

describe("date and number formatting", () => {
  it("formats calendar dates per locale", () => {
    const date = new Date(2026, 8, 25);
    const viDate = formatDate("vi", date);
    const enDate = formatDate("en", date);
    expect(viDate).toContain("2026");
    expect(enDate).toContain("September");
    expect(enDate).toContain("25");
    expect(enDate).toContain("2026");
    expect(viDate).not.toBe(enDate);
  });

  it("returns empty string for invalid dates", () => {
    expect(formatDate("vi", "not-a-date")).toBe("");
  });

  it("formats numbers per locale", () => {
    expect(formatNumber("vi", 1234567)).toBe(
      new Intl.NumberFormat(LOCALE_TAGS.vi).format(1234567),
    );
    expect(formatNumber("en", 1234567)).toBe(
      new Intl.NumberFormat(LOCALE_TAGS.en).format(1234567),
    );
  });

  it("guards non-finite numbers", () => {
    expect(formatNumber("vi", Number.NaN)).toBe("0");
  });
});
