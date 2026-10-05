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

describe("offline copy is truthful about local playback", () => {
  /**
   * A local file plays with NO connectivity — real browser verification,
   * `ARCHITECTURE.md` §35.1. So no offline string may claim that music needs an
   * internet connection: that was true of provider playback only, and the copy
   * said it about ALL playback, which is how a listener holding a folder was told
   * their own music had become unplayable.
   *
   * These assertions are about MEANING, not exact prose: the wording is free to
   * change, the claim is not. Each locale is checked separately because a
   * corrected English string with a stale Vietnamese one is the failure this
   * exists to catch.
   */
  const OFFLINE_KEYS = [
    "offline.message",
    "errors.offlineBar",
    "errors.offlineHint",
    "errors.offlineMessage",
  ] as const;

  function valueAt(locale: "en" | "vi", key: string): string {
    const dicts = getDictionaries();
    let node: unknown = dicts[locale];
    for (const part of key.split(".")) {
      node = (node as Record<string, unknown>)[part];
    }
    expect(typeof node, `${key} is not a string in ${locale}`).toBe("string");
    return node as string;
  }

  it("never claims playback requires a connection, in any locale", () => {
    for (const locale of ["en", "vi"] as const) {
      for (const key of OFFLINE_KEYS) {
        const value = valueAt(locale, key);
        expect(value, `${locale} ${key}`).not.toMatch(
          /music playback requires|requires an internet connection|needs internet|nghe nhạc cần/i,
        );
      }
    }
  });

  it("says local files still play, in English and Vietnamese", () => {
    // The banner and the offline hint are the two strings a listener actually
    // reads while disconnected, so both have to carry the reassurance. The
    // terms are the project's own: "Local files" in English, "tệp cục bộ" in
    // Vietnamese (`offline.unsupportedTitle` already uses it).
    expect(valueAt("en", "offline.message")).toMatch(/local files still play/i);
    expect(valueAt("en", "errors.offlineHint")).toMatch(/local files/i);
    expect(valueAt("en", "errors.offlineHint")).toMatch(/still play/i);

    expect(valueAt("vi", "offline.message")).toContain("Tệp cục bộ vẫn phát được");
    expect(valueAt("vi", "errors.offlineHint")).toContain("Tệp cục bộ");
    expect(valueAt("vi", "errors.offlineHint")).toContain("vẫn phát được");
  });

  it("still says what genuinely does need a connection", () => {
    // The correction must not become "everything works offline". Online music
    // and the network-failure copy keep naming the connection, because for those
    // it is true.
    expect(valueAt("en", "offline.message")).toMatch(/online music needs a connection/i);
    expect(valueAt("vi", "offline.message")).toContain("nhạc trực tuyến cần có kết nối");
    expect(valueAt("en", "errors.offlineMessage")).toMatch(/needs a connection/i);
    expect(valueAt("vi", "errors.offlineMessage")).toContain("cần có kết nối");
  });

  it("leaves the provider and network failure copy alone", () => {
    // Unrelated translations, pinned so the change above cannot have drifted
    // them: these still name the service or the connection, and none of them
    // talks about local playback.
    expect(valueAt("en", "errors.networkUnavailable")).toContain("Check your connection");
    expect(valueAt("en", "errors.providerUnavailable")).toContain(
      "isn't available from the current sources",
    );
    expect(valueAt("en", "errors.providerEmpty")).toContain("The music service");
    expect(valueAt("en", "errors.playbackUnavailable")).toBe(
      "This track can't be played right now.",
    );
    expect(valueAt("vi", "errors.networkUnavailable")).toContain("Kiểm tra mạng");
    expect(valueAt("vi", "errors.playbackUnavailable")).toContain("không phát được");
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
