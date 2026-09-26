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
