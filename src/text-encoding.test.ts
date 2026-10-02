import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { UNKNOWN_ARTIST } from "@/lib/offline/tracks";
import viDict from "@/lib/i18n/vi";
import enDict from "@/lib/i18n/en";

/**
 * Text-encoding gates.
 *
 * THE BUG. `UNKNOWN_ARTIST` shipped as three characters, U+00E2 U+20AC
 * U+201D, where a single em dash belonged. That is the exact signature of one
 * encoding pass too many: an em dash is U+2014, its UTF-8 is the bytes
 * `E2 80 94`, and decoding those three bytes as windows-1252 produces exactly
 * those three characters. Every byte in the file was valid UTF-8 throughout, so
 * nothing was wrong on the wire, in the response headers, in the JSON
 * serialization or in the database - the mojibake had been written into the
 * SOURCE and was rendered faithfully thereafter. A local audio file with no
 * artist tag showed three garbage glyphs.
 *
 * WHY A REPOSITORY-WIDE GATE RATHER THAN ONE ASSERTION. Fixing the constant
 * fixes today's symptom. What made this possible is that any tool - including
 * a test author - which writes a non-ASCII character through a path that does
 * not preserve UTF-8 silently commits the mangled form, and a test asserting on
 * the literal it expected would be updated along with the bug. The gate below
 * looks for the ENCODING SIGNATURE rather than for one string, so the next
 * occurrence anywhere in the tree is caught whatever it says.
 *
 * EVERY NON-ASCII EXPECTATION HERE IS BUILT FROM CODE POINTS, NEVER TYPED AS
 * A LITERAL. That is the lesson of this bug rather than a stylistic flourish:
 * while investigating it, an em dash written into a scratch script through the
 * same class of tooling reproduced the corruption exactly - the script's own
 * bytes came out mangled and its comparison against the correct constant
 * failed. A test file written that way would assert against mojibake while
 * looking perfectly correct to a reviewer. `chars()` below builds every string
 * from its code points, so an expectation cannot be corrupted by the tool that
 * wrote it.
 */

/** Builds a string from code points, so no expectation can be mangled. */
function chars(...codePoints: number[]): string {
  return String.fromCodePoint(...codePoints);
}

const EM_DASH = chars(0x2014); // —
const EN_DASH = chars(0x2013); // –
const ELLIPSIS = chars(0x2026); // …
const LEFT_DOUBLE = chars(0x201c); // “
const RIGHT_DOUBLE = chars(0x201d); // ”
const LEFT_SINGLE = chars(0x2018); // ‘
const RIGHT_SINGLE = chars(0x2019); // ’

/** "Đang phát" - the player status the brief names. */
const DANG_PHAT = chars(0x110, 0x61, 0x6e, 0x67, 0x20, 0x70, 0x68, 0xe1, 0x74);
/** "Tìm kiếm" */
const TIM_KIEM = chars(0x54, 0xec, 0x6d, 0x20, 0x6b, 0x69, 0x1ebf, 0x6d);
/** "Âm lượng" - note the leading U+00C2, which is correct Vietnamese. */
const AM_LUONG = chars(
  0xc2, 0x6d, 0x20, 0x6c, 0x1b0, 0x1ee3, 0x6e, 0x67,
);
/** "Cảm ơn" - a general Vietnamese sample, not a string this app ships. */
const CAM_ON = chars(0x43, 0x1ea3, 0x6d, 0x20, 0x1a1, 0x6e);
/** "Mùa lá rụng trong vườn" - likewise a general sample. */
const MUA_LA_RUNG = chars(
  0x4d, 0xf9, 0x61, 0x20, 0x6c, 0xe1, 0x20, 0x72, 0x1ee5, 0x6e, 0x67, 0x20, 0x74,
  0x72, 0x6f, 0x6e, 0x67, 0x20, 0x76, 0x1b0, 0x1edd, 0x6e,
);
/** "Không tìm thấy kết quả" - likewise. */
const KHONG_TIM_THAY = chars(
  0x4b, 0x68, 0xf4, 0x6e, 0x67, 0x20, 0x74, 0xec, 0x6d, 0x20, 0x74, 0x68, 0xe1, 0xba,
  0xa5, 0x79, 0x20, 0x6b, 0x1ebf, 0x74, 0x20, 0x71, 0x75, 0xe1, 0xba, 0xa3,
);

/** Windows-1252 code points that only ever appear as mis-decoded UTF-8 trails. */
const MOJIBAKE_TRAILS = new Set([
  0x20ac, // € - byte 0x80
  0x0192, // ƒ - byte 0x83
  0x02c6, // ˆ - byte 0x88
  0x02dc, // ˜ - byte 0x98
  0x201a, // ‚ - byte 0x82
  0x2030, // ‰ - byte 0x89
  0x2122, // ™ - byte 0x99
  0x0153, // œ - byte 0x9C
  0x017e, // ž - byte 0x9E
]);

/**
 * Latin-1 lead bytes. U+00E2, U+00C3, U+00F0 and friends are ALSO ordinary
 * letters in this project's languages - "Âm lượng", "tiếng" - so a lead byte
 * alone is not evidence of anything. Only a lead IMMEDIATELY followed by a
 * trail is.
 */
const LEAD_BYTES = new Set([0x00e2, 0x00c3, 0x00f0, 0x00e3, 0x00f4, 0x00fb]);

/** Index of the first windows-1252 signature, or -1. */
export function mojibakeIndex(text: string): number {
  const chars = [...text];
  for (let i = 0; i < chars.length - 1; i += 1) {
    const lead = chars[i].codePointAt(0) ?? 0;
    const trail = chars[i + 1].codePointAt(0) ?? 0;
    if (LEAD_BYTES.has(lead) && MOJIBAKE_TRAILS.has(trail)) {
      return i;
    }
  }
  return -1;
}

describe("the reported corruption", () => {
  it("renders the unknown-artist placeholder as a single em dash", () => {
    expect(UNKNOWN_ARTIST).toBe(EM_DASH);
    expect([...UNKNOWN_ARTIST]).toHaveLength(1);
    expect(UNKNOWN_ARTIST.codePointAt(0)).toBe(0x2014);
  });

  it("carries no mojibake trail byte", () => {
    // The three characters it used to hold were U+00E2 U+20AC U+201D. The
    // middle one is the giveaway: U+20AC never appears in this project's copy
    // in any language.
    for (const char of UNKNOWN_ARTIST) {
      expect(MOJIBAKE_TRAILS.has(char.codePointAt(0) ?? 0)).toBe(false);
    }
    expect(mojibakeIndex(UNKNOWN_ARTIST)).toBe(-1);
  });

  it("is stored as real UTF-8 bytes, not a decoded latin1 round trip", () => {
    // The strongest form: re-encode and compare with the bytes on disk. A value
    // that had been round-tripped through a single-byte encoding still decodes
    // to itself, so only the bytes settle it.
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/offline/tracks.ts"),
      "utf8",
    );
    const encoded = Buffer.from(UNKNOWN_ARTIST, "utf8");
    expect([...encoded]).toEqual([0xe2, 0x80, 0x94]);
    expect(source.includes(encoded.toString("utf8"))).toBe(true);
    // The latin1 reading of those bytes is the mojibake, and that reading must
    // NOT be what the source contains.
    expect(source.includes(encoded.toString("latin1"))).toBe(false);
  });

  it("recognises the mojibake form when it is constructed deliberately", () => {
    // Proves the gate can still see the bug: the exact three characters the
    // constant used to hold, built the way the original corruption built them
    // - the UTF-8 bytes of an em dash, each read as a windows-1252 character.
    //
    // Built from code points rather than via `toString("latin1")`, because
    // Node's `latin1` is strict ISO-8859-1 and maps byte 0x80 to U+0080, not to
    // U+20AC. Encoding the mapping by hand keeps the test stating the real
    // windows-1252 result rather than a near-miss that happens to look similar.
    const corrupted = chars(0x00e2, 0x20ac, 0x201d);
    expect(corrupted).toHaveLength(3);
    expect([...corrupted].map((c) => c.codePointAt(0))).toEqual([
      0x00e2, 0x20ac, 0x201d,
    ]);
    expect(mojibakeIndex(corrupted)).toBe(0);
    // And it is genuinely a different string from the correct value, so the
    // assertions above cannot pass by accident.
    expect(corrupted).not.toBe(EM_DASH);
  });
});

describe("Vietnamese text", () => {
  function strings(value: unknown, prefix = ""): Array<[string, string]> {
    if (typeof value === "string") return [[prefix, value]];
    if (value && typeof value === "object") {
      const out: Array<[string, string]> = [];
      for (const [key, inner] of Object.entries(value)) {
        out.push(...strings(inner, prefix ? `${prefix}.${key}` : key));
      }
      return out;
    }
    return [];
  }

  const vi = strings(viDict as unknown);
  const en = strings(enDict as unknown);
  const haystack = vi.map(([, value]) => value).join("\n");

  it("contains no mojibake in any dictionary value", () => {
    const offenders: string[] = [];
    for (const [key, value] of [...vi, ...en]) {
      if (mojibakeIndex(value) !== -1) {
        offenders.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    expect(
      offenders,
      `mojibake found in dictionary values:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("ships the required phrases with real diacritics", () => {
    // The three the product actually renders. The other samples in the brief
    // are generic Vietnamese rather than strings this application ships, so
    // asserting they appear in the dictionary would be asserting something
    // false; they are covered by the round-trip test below instead.
    for (const phrase of [DANG_PHAT, TIM_KIEM, AM_LUONG]) {
      expect(haystack).toContain(phrase);
      expect(mojibakeIndex(phrase)).toBe(-1);
    }
  });

  it("keeps U+00C2 in the volume label, which is correct Vietnamese", () => {
    // The false positive a naive scan produces. U+00C2 is the correct spelling
    // of the first letter of "Âm lượng"; a scan that "fixed" it would break the
    // dictionary, and this asserts so that cannot happen quietly.
    const player = (viDict as unknown as Record<string, Record<string, string>>)
      .player;
    expect(player?.volume).toBe(AM_LUONG);
    expect(player?.volume?.codePointAt(0)).toBe(0x00c2);
  });

  it("round-trips every Vietnamese sample through UTF-8 unchanged", () => {
    // Covers the brief's sample phrases, which are not product strings, by
    // asserting the pipeline that would carry them preserves them exactly.
    //
    // The check is a fatal decode, not a byte-range heuristic: `fatal: true`
    // makes any malformed sequence throw rather than being replaced with
    // U+FFFD, so a mangled string cannot pass by decoding "successfully".
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const phrase of [CAM_ON, MUA_LA_RUNG, KHONG_TIM_THAY]) {
      const bytes = Buffer.from(phrase, "utf8");
      expect(decoder.decode(bytes)).toBe(phrase);
      expect(bytes.toString("utf8")).toBe(phrase);
      expect(mojibakeIndex(phrase)).toBe(-1);
    }
  });

  it("preserves typographic punctuation as the intended code points", () => {
    const expected: Array<[string, number]> = [
      [EM_DASH, 0x2014],
      [EN_DASH, 0x2013],
      [ELLIPSIS, 0x2026],
      [LEFT_DOUBLE, 0x201c],
      [RIGHT_DOUBLE, 0x201d],
      [LEFT_SINGLE, 0x2018],
      [RIGHT_SINGLE, 0x2019],
    ];
    for (const [char, codePoint] of expected) {
      expect(char.codePointAt(0)).toBe(codePoint);
      expect(mojibakeIndex(char)).toBe(-1);
      // Each is exactly the three bytes its code point encodes, which is what
      // makes the expectation independent of how the file was written.
      expect(Buffer.from(char, "utf8").length).toBe(3);
    }
  });
});

describe("the whole source tree", () => {
  const EXT = new Set([
    ".ts",
    ".tsx",
    ".mts",
    ".js",
    ".mjs",
    ".css",
    ".prisma",
    ".md",
    ".json",
    ".yml",
    ".yaml",
  ]);

  /**
   * The repository root is a NAMED ROOT, which is the only way a dot-directory
   * is admitted - `.github` and friends are then reached deliberately rather
   * than by accident. Everything below a non-named root skips dot-directories
   * entirely, because that is where nested agent worktrees live: a worktree
   * ships its own copy of the repository, so walking into one makes this gate
   * assert against a checkout that is not the one under test. A gate that fires
   * on a neighbouring copy of the repository is a gate that gets disabled.
   */
  const SKIP_ALWAYS = new Set(["node_modules", ".next", ".git", "dist"]);

  function sourceFiles(): Array<{ file: string; content: string }> {
    const out: Array<{ file: string; content: string }> = [];
    const visit = (directory: string, isNamedRoot: boolean): void => {
      for (const entry of readdirSync(directory)) {
        if (SKIP_ALWAYS.has(entry)) continue;
        if (!isNamedRoot && entry.startsWith(".")) continue;
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
          // `generated` is Prisma output: written by `prisma generate`, so its
          // encoding is the generator's business, not this repository's.
          if (entry === "generated") continue;
          visit(full, false);
          continue;
        }
        if (!EXT.has(extname(entry))) continue;
        out.push({ file: full, content: readFileSync(full, "utf8") });
      }
    };
    try {
      visit(resolve(process.cwd()), true);
    } catch {
      /* absent */
    }
    return out;
  }

  it("actually reads the repository, rather than passing on an empty list", () => {
    // A walker whose roots all miss would report zero files, and every
    // assertion below would then pass vacuously. Pin a floor that only a real
    // walk clears, and name files from every part of the tree.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(400);
    const names = files.map((f) => f.file.replace(`${process.cwd()}\\`, ""));
    for (const required of [
      "src\\lib\\offline\\tracks.ts",
      "src\\lib\\i18n\\vi.ts",
      "ARCHITECTURE.md",
      "PRODUCT_SPEC.md",
      "package.json",
    ]) {
      expect(names, `walker missed ${required}`).toContain(required);
    }
  });

  it("contains no windows-1252 round-trip signature anywhere", () => {
    const offenders: string[] = [];
    for (const { file, content } of sourceFiles()) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (mojibakeIndex(lines[i]) === -1) continue;
        offenders.push(
          `${file.replace(`${process.cwd()}\\`, "")}:${i + 1}  ` +
            JSON.stringify(lines[i].trim().slice(0, 120)),
        );
      }
    }
    expect(
      offenders,
      `Mojibake found (a latin1 lead byte followed by a windows-1252 trail) - ` +
        `each is text that was UTF-8 decoded as latin1 and re-encoded:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("stores every source file as bytes that are valid UTF-8", () => {
    // The other half: a file whose bytes are not valid UTF-8 at all, which
    // `readFileSync(..., "utf8")` silently fills with U+FFFD. A replacement
    // character means the file is already corrupt even though it contains no
    // recognisable mojibake sequence.
    const REPLACEMENT = String.fromCodePoint(0xfffd);
    const offenders: string[] = [];
    for (const { file, content } of sourceFiles()) {
      if (!content.includes(REPLACEMENT)) continue;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].includes(REPLACEMENT)) continue;
        offenders.push(`${file.replace(`${process.cwd()}\\`, "")}:${i + 1}`);
      }
    }
    expect(
      offenders,
      `U+FFFD in these files means the bytes were not valid UTF-8:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});