/**
 * Pure comparison-text utilities for the TrackMatcher.
 *
 * These produce NORMALIZED COMPARISON VIEWS only — canonical TrackIdentity
 * objects are never rewritten. Display/original metadata stays
 * source-faithful; everything here is deterministic, local, and free of
 * network, database, or provider dependencies.
 *
 * Conservatism rules:
 * - Only bracketed segments `(...)` / `[...]` and a trailing spaced dash
 *   (` - X`, ` – X`) are treated as version/feature annotations. Bare words
 *   in a main title (e.g. a hyphenated name) are never reinterpreted.
 * - Unknown annotations stay part of the base title instead of being
 *   stripped: an unrecognized `(...)` must not silently vanish.
 * - Diacritic folding is minimal (combining-mark strip + đ): representation
 *   normalization, not transliteration.
 */

export type VersionKind =
  | "live"
  | "acoustic"
  | "instrumental"
  | "karaoke"
  | "cover"
  | "remix"
  | "sped"
  | "demo"
  | "remaster";

/** Version kinds that normally denote a distinct recording. */
export const DISTINCT_VERSION_KINDS: readonly VersionKind[] = [
  "live",
  "acoustic",
  "instrumental",
  "karaoke",
  "cover",
  "remix",
  "sped",
  "demo",
];

export interface ParsedTitle {
  /** Comparison base with recognized annotations removed. */
  base: string;
  /** Recognized version kinds (empty = standard/unmarked). */
  kinds: VersionKind[];
  /** Normalized unrecognized annotation segments. */
  others: string[];
  /** Feature annotations (informational; artists[] is authoritative). */
  features: string[];
}

/**
 * NFKC + locale-neutral lowercase + separator/punctuation cleanup +
 * collapsed whitespace. Preserves scripts and diacritics as composed.
 */
export function normalizeBase(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛“”„‟'"]/g, "")
    .replace(/[–—−]/g, "-")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Minimal fold for cross-encoding comparison: combining-mark strip plus
 * đ→d. Catches "Đen" vs "Den"-style provider variants without guessing
 * across languages.
 */
export function foldDiacritics(normalized: string): string {
  return normalized
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/đ/g, "d")
    .normalize("NFC");
}

export function normalizeArtistName(name: string): string {
  return normalizeBase(name);
}

const BRACKET_PATTERN = /[\(\[]([^()\[\]]*)[\)\]]/g;
const TRAILING_DASH_PATTERN = /^(.*?)[\s]+[-–—][\s]+([^-–—]+?)\s*$/;
const FEATURE_PATTERN = /^(feat\.?|ft\.?|featuring|with)\b\s*(.*)$/i;
const STANDARD_PATTERN =
  /^(original|original mix|album version|single version|studio version|studio)\.?$/i;

interface SegmentClass {
  kind: "feature" | "standard" | "version" | "other";
  versionKind?: VersionKind;
  text: string;
}

const KIND_TESTS: Array<{ kind: VersionKind; pattern: RegExp }> = [
  { kind: "live", pattern: /\blive\b|\bunplugged\b/i },
  { kind: "acoustic", pattern: /\bacoustic\b/i },
  { kind: "instrumental", pattern: /\binstrumental(s)?\b|\boff vocal\b/i },
  { kind: "karaoke", pattern: /\bkaraoke\b/i },
  { kind: "cover", pattern: /\bcover\b/i },
  {
    kind: "remix",
    pattern:
      /\bremix\b|\bremixed\b|\bclub mix\b|\bextended(\s+mix)?\b|\bradio edit\b|^(mix|edit|club|dub)\.?$/i,
  },
  {
    kind: "sped",
    pattern: /\bsped[\s-]*up\b|\bspeed[\s-]*up\b|\bslowed\b|\bslow\s*\+\s*reverb\b|\bslowed\s*\+\s*reverb\b|\bnightcore\b/i,
  },
  { kind: "demo", pattern: /\bdemo\b/i },
  { kind: "remaster", pattern: /remaster/i },
];

function classifySegment(raw: string): SegmentClass {
  const text = raw.trim();
  const feature = FEATURE_PATTERN.exec(text);
  if (feature) {
    return { kind: "feature", text: (feature[2] ?? "").trim() };
  }
  if (STANDARD_PATTERN.test(text)) {
    return { kind: "standard", text };
  }
  for (const { kind, pattern } of KIND_TESTS) {
    if (pattern.test(text)) {
      return { kind: "version", versionKind: kind, text };
    }
  }
  return { kind: "other", text };
}

/**
 * Splits a raw title into comparison base, version kinds, unrecognized
 * annotations, and feature annotations. Never mutates its input.
 */
export function parseTitleVersion(title: string): ParsedTitle {
  const kinds = new Set<VersionKind>();
  const others: string[] = [];
  const features: string[] = [];
  let remainder = title;

  const consume = (segment: string): string => {
    const classified = classifySegment(segment);
    if (classified.kind === "feature") {
      if (classified.text.length > 0) {
        features.push(normalizeBase(classified.text));
      }
      return "";
    }
    if (classified.kind === "standard") {
      return "";
    }
    if (classified.kind === "version" && classified.versionKind) {
      kinds.add(classified.versionKind);
      return "";
    }
    const normalized = normalizeBase(segment);
    if (normalized.length > 0) {
      others.push(normalized);
    }
    return segment;
  };

  remainder = remainder.replace(BRACKET_PATTERN, (match, inner: string) => {
    const kept = consume(String(inner));
    return kept.length > 0 ? `(${kept})` : "";
  });

  const dash = TRAILING_DASH_PATTERN.exec(remainder);
  if (dash) {
    const candidate = classifySegment(dash[2] ?? "");
    if (candidate.kind === "feature") {
      if (candidate.text.length > 0) {
        features.push(normalizeBase(candidate.text));
      }
      remainder = dash[1] ?? remainder;
    } else if (candidate.kind === "standard") {
      remainder = dash[1] ?? remainder;
    } else if (candidate.kind === "version" && candidate.versionKind) {
      kinds.add(candidate.versionKind);
      remainder = dash[1] ?? remainder;
    }
    // "other" dash suffixes stay in the base: never strip blindly.
  }

  return {
    base: normalizeBase(remainder),
    kinds: [...kinds].sort(),
    others: others.sort(),
    features: features.sort(),
  };
}

export type VersionComparison =
  | { readonly compatible: true; readonly sameKind: boolean; readonly remasterAsymmetry: boolean; readonly unknownAsymmetry: boolean }
  | { readonly compatible: false; readonly hardReject: true };

/**
 * Compares parsed version markers. A distinct recording kind present on
 * exactly one side (or clashing kinds) is a hard contradiction.
 * Remaster-only asymmetry is soft. Identical unrecognized annotations are
 * compatible; one-sided ones are a soft negative.
 */
export function compareVersions(left: ParsedTitle, right: ParsedTitle): VersionComparison {
  const leftKinds = new Set(left.kinds);
  const rightKinds = new Set(right.kinds);
  const leftDistinct = [...leftKinds].filter((kind) =>
    (DISTINCT_VERSION_KINDS as readonly string[]).includes(kind),
  );
  const rightDistinct = [...rightKinds].filter((kind) =>
    (DISTINCT_VERSION_KINDS as readonly string[]).includes(kind),
  );
  const sameDistinct =
    leftDistinct.length === rightDistinct.length &&
    leftDistinct.every((kind) => rightKinds.has(kind as VersionKind));

  if (!sameDistinct) {
    return { compatible: false, hardReject: true };
  }

  const leftRemaster = leftKinds.has("remaster");
  const rightRemaster = rightKinds.has("remaster");
  const leftOthers = new Set(left.others);
  const rightOthers = new Set(right.others);
  const othersEqual =
    leftOthers.size === rightOthers.size &&
    [...leftOthers].every((other) => rightOthers.has(other));

  return {
    compatible: true,
    sameKind:
      leftKinds.size === rightKinds.size &&
      [...leftKinds].every((kind) => rightKinds.has(kind)) &&
      othersEqual,
    remasterAsymmetry: leftRemaster !== rightRemaster,
    unknownAsymmetry: !othersEqual,
  };
}

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/;

/**
 * Normalizes an ISRC (case/space/hyphen tolerant). Returns null for
 * malformed values — invalid strings are never matching evidence.
 */
export function normalizeIsrc(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.toUpperCase().replace(/[\s-]/g, "");
  return ISRC_PATTERN.test(cleaned) ? cleaned : null;
}

/** Collects the valid ISRCs attached to an identity's source references. */
export function identityIsrcs(
  sources: Array<{ metadata?: { isrc?: string } | undefined }>,
): Set<string> {
  const found = new Set<string>();
  for (const source of sources) {
    const normalized = normalizeIsrc(source.metadata?.isrc);
    if (normalized) {
      found.add(normalized);
    }
  }
  return found;
}

export function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

export function tokenOverlap(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of new Set(left)) {
    if (rightSet.has(token)) {
      shared += 1;
    }
  }
  return shared / Math.min(new Set(left).size, rightSet.size);
}
