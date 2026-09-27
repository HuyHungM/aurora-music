import type { SourceType } from "@/lib/domain";
import type {
  DetectedSource,
  DetectedSourceKind,
} from "@/lib/providers/source-detection";
import {
  detectSource,
  providerHostOf,
} from "@/lib/providers/source-detection";

/**
 * What the single Search field was handed: prose, a provider link, or a link
 * to a host Aurora does not serve.
 *
 * This module deliberately contains no resource parsing. `detectSource` is
 * the canonical URL parser (it owns host allowlisting, resource-type
 * mapping and id validation) and `providerHostOf` answers the one security
 * question it does not — "is this host even ours?" — so classification is a
 * layer over the existing detector rather than a second detector beside it.
 *
 * ```text
 * raw input
 *   -> looksLikeUrl()            scheme + single-token check only
 *      false -> query            (the existing unified text search)
 *      true  -> detectSource()
 *                hit  -> source  (resolve the resource directly)
 *                miss -> unsupported-url
 * ```
 *
 * The classification happens BEFORE any network call, which is why a pasted
 * link never costs a text search: Aurora's search is submit-driven, so the
 * only request a link can reach is the one this classifier routes it to.
 */
export type SearchInputKind =
  | "query"
  | "unsupported-url"
  | `${SourceType}-${DetectedSourceKind}`;

export type SearchInput =
  | { kind: "query"; query: string }
  | {
      kind: "source";
      source: DetectedSource;
    }
  | {
      /**
       * `unsupported-host`: parses as a URL on a host Aurora does not serve.
       * `malformed`: a provider host that yielded no readable resource —
       * a truncated id, an `/artist/` or `/channel/` path no parser accepts,
       * or a string that is not a URL at all.
       */
      kind: "unsupported-url";
      reason: "unsupported-host" | "malformed";
      url: string;
    };

/**
 * A single http(s) URL with no whitespace in it.
 *
 * The whitespace rule is what keeps prose intact: "listen to
 * https://youtu.be/abc later" is a text query containing a link, not a link,
 * and the whole input has to be the link before classification may take over.
 *
 * A string that starts with `http(s)://` but does not parse still counts —
 * `https://` is an attempted URL, not a sentence — and is reported as
 * malformed rather than being sent into a provider as if it were whole.
 */
const HTTP_SCHEME = /^https?:\/\//i;

export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  return (
    trimmed.length > 0 &&
    !/\s/.test(trimmed) &&
    HTTP_SCHEME.test(trimmed)
  );
}

/**
 * Classifies raw search input.
 *
 * `query` keeps the trimmed text so the caller can use it directly; a URL
 * keeps its raw form because the canonical resource lives in `source.id`
 * (see `canonicalSourceUrl`) and tracking parameters are not identity.
 */
export function classifySearchInput(raw: string): SearchInput {
  const trimmed = raw.trim();
  if (!looksLikeUrl(trimmed)) {
    return { kind: "query", query: trimmed };
  }

  const source = detectSource(trimmed);
  if (source) {
    return { kind: "source", source };
  }

  // Not a resource we can read. A provider host means the shape is ours and
  // the id/type is not; a foreign host means the link type is not ours; a
  // string that does not parse is malformed. Every case stops here, so an
  // unsupported link is never handed to the text search as if it were prose.
  if (providerHostOf(trimmed) !== null) {
    return { kind: "unsupported-url", reason: "malformed", url: trimmed };
  }
  if (!parses(trimmed)) {
    return { kind: "unsupported-url", reason: "malformed", url: trimmed };
  }
  return { kind: "unsupported-url", reason: "unsupported-host", url: trimmed };
}

function parses(input: string): boolean {
  try {
    new URL(input);
    return true;
  } catch {
    return false;
  }
}

/** The `SearchInputKind` of a classified input. */
export function searchInputKind(input: SearchInput): SearchInputKind {
  return input.kind === "source"
    ? `${input.source.provider}-${input.source.kind}`
    : input.kind;
}

/**
 * Display name for a provider, for the "link detected" indicator and for the
 * label on a resolved link's card.
 *
 * Hardcoded rather than translated because these are brand names: they are
 * spelled the same in every locale, which is also why no provider
 * display-name i18n map exists anywhere in `src`. The surrounding sentence is
 * what gets translated, and it arrives as a template (see
 * `searchForm.linkDetected`) so the word order stays correct in each locale.
 */
const PROVIDER_LABEL: Record<string, string> = {
  youtube: "YouTube",
  spotify: "Spotify",
  deezer: "Deezer",
};

export function providerDisplayName(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

/**
 * Canonical resource URL for a detected source.
 *
 * Two pastes of the same resource produce the same string, because the
 * identity is `source.id` and everything else (`?si=`, `&t=`, `&list=`,
 * a locale segment, a `www.` prefix) is decoration the parsers already
 * discarded. Rebuilding rather than reusing `source.url` is what makes the
 * normalized form stable — it is also the form search history stores, so a
 * history row re-classifies to the same resource instead of becoming a
 * different query every time someone shares a link.
 */
export function canonicalSourceUrl(source: DetectedSource): string {
  if (source.provider === "youtube") {
    return source.kind === "playlist"
      ? `https://www.youtube.com/playlist?list=${encodeURIComponent(source.id)}`
      : `https://www.youtube.com/watch?v=${encodeURIComponent(source.id)}`;
  }
  const host =
    source.provider === "spotify" ? "open.spotify.com" : "www.deezer.com";
  return `https://${host}/${source.kind}/${encodeURIComponent(source.id)}`;
}

/**
 * The normalized value to record and to re-submit.
 *
 * Returns `""` for an unsupported link on purpose: a link Aurora could not
 * read is not a search the person made, and recording it would put a broken
 * entry in history that re-classifies to the same dead end.
 */
export function canonicalSearchInput(raw: string): string {
  const input = classifySearchInput(raw);
  if (input.kind === "source") {
    return canonicalSourceUrl(input.source);
  }
  if (input.kind === "query") {
    return input.query;
  }
  return "";
}
