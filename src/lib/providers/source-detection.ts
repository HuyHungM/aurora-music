import type { SourceType } from "@/lib/domain";

/**
 * Provider-independent source detection for the Music Engine.
 *
 * Maps supported provider URLs to a normalized representation without
 * coupling callers (UI, actions, engine) to provider-specific parsing.
 * Small per-provider parsers are preferred over one opaque expression.
 */

export type DetectedSourceKind = "track" | "album" | "playlist";

export interface DetectedSource {
  provider: SourceType;
  kind: DetectedSourceKind;
  /** Stable provider-scoped id (videoId / trackId / listId). Never a stream URL. */
  id: string;
  /** Original input URL, preserved for display/linking. */
  url: string;
}

function parseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return new URL(trimmed);
  } catch {
    // Bare domains without a scheme (e.g. "youtu.be/abc") are not accepted:
    // detection requires an explicit http(s) URL to avoid false positives.
    return null;
  }
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

function firstPathSegment(pathname: string): string {
  return decodeURIComponent(pathname.split("/").filter(Boolean)[0] ?? "");
}

function isYouTubeVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(value);
}

function isSpotifyId(value: string): boolean {
  return /^[A-Za-z0-9]{22}$/.test(value);
}

function isDeezerId(value: string): boolean {
  return /^[0-9]{1,16}$/.test(value);
}

/**
 * Parses YouTube track/playlist URLs.
 * Tracks: youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID,
 * youtube.com/shorts/ID (music subdomains included).
 * Playlists: youtube.com/playlist?list=ID. YouTube has no album concept,
 * so album URLs are never produced here.
 */
export function parseYouTubeUrl(input: string): DetectedSource | null {
  const url = parseUrl(input);
  if (!url) {
    return null;
  }
  const host = hostOf(url);
  const normalized = input.trim();

  if (host === "youtu.be") {
    const id = firstPathSegment(url.pathname);
    if (!isYouTubeVideoId(id)) {
      return null;
    }
    return { provider: "youtube", kind: "track", id, url: normalized };
  }

  if (host === "youtube.com" || host === "music.youtube.com") {
    const segments = url.pathname.split("/").filter(Boolean);
    const head = segments[0] ?? "";

    if (head === "watch") {
      const id = url.searchParams.get("v") ?? "";
      if (!isYouTubeVideoId(id)) {
        return null;
      }
      return { provider: "youtube", kind: "track", id, url: normalized };
    }

    if (head === "playlist") {
      const id = url.searchParams.get("list") ?? "";
      if (id.length === 0) {
        return null;
      }
      return { provider: "youtube", kind: "playlist", id, url: normalized };
    }

    if ((head === "embed" || head === "shorts") && segments.length >= 2) {
      const id = decodeURIComponent(segments[1] ?? "");
      if (!isYouTubeVideoId(id)) {
        return null;
      }
      return { provider: "youtube", kind: "track", id, url: normalized };
    }
  }

  return null;
}

const SPOTIFY_KINDS: Record<string, DetectedSourceKind> = {
  track: "track",
  album: "album",
  playlist: "playlist",
};

/**
 * Parses open.spotify.com track/album/playlist URLs, tolerating an
 * optional locale segment (open.spotify.com/intl-xx/track/ID).
 */
export function parseSpotifyUrl(input: string): DetectedSource | null {
  const url = parseUrl(input);
  if (!url) {
    return null;
  }
  if (hostOf(url) !== "open.spotify.com") {
    return null;
  }
  const normalized = input.trim();
  const segments = url.pathname.split("/").filter(Boolean);
  const offset = segments[0]?.startsWith("intl-") ? 1 : 0;
  const kindSegment = segments[offset];
  const idSegment = segments[offset + 1];
  if (!kindSegment || !idSegment) {
    return null;
  }
  const kind = SPOTIFY_KINDS[kindSegment];
  if (!kind) {
    return null;
  }
  const id = decodeURIComponent(idSegment);
  if (!isSpotifyId(id)) {
    return null;
  }
  return { provider: "spotify", kind, id, url: normalized };
}

const DEEZER_KINDS: Record<string, DetectedSourceKind> = {
  track: "track",
  album: "album",
  playlist: "playlist",
};

/**
 * Parses deezer.com track/album/playlist URLs, tolerating an optional
 * locale segment (deezer.com/us/track/ID).
 */
export function parseDeezerUrl(input: string): DetectedSource | null {
  const url = parseUrl(input);
  if (!url) {
    return null;
  }
  if (hostOf(url) !== "deezer.com") {
    return null;
  }
  const normalized = input.trim();
  const segments = url.pathname.split("/").filter(Boolean);
  const offset =
    segments.length === 3 && /^[a-z]{2}$/i.test(segments[0] ?? "") ? 1 : 0;
  const kindSegment = segments[offset];
  const idSegment = segments[offset + 1];
  if (!kindSegment || !idSegment || segments.length > offset + 2) {
    return null;
  }
  const kind = DEEZER_KINDS[kindSegment];
  if (!kind) {
    return null;
  }
  const id = decodeURIComponent(idSegment);
  if (!isDeezerId(id)) {
    return null;
  }
  return { provider: "deezer", kind, id, url: normalized };
}

/**
 * The hostnames the three parsers above accept, in one place.
 *
 * It lives beside them rather than beside any caller because "only explicitly
 * supported Spotify/YouTube hosts are recognised" is a claim about this module
 * as a whole. A caller that kept its own copy would be a second answer that
 * can silently drift from the parsers: the caller could call a host a provider
 * link and the parser would then refuse it, or the parser could start
 * accepting a host the caller still reports as foreign.
 */
const PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  "youtube.com",
  "music.youtube.com",
  "youtu.be",
  "open.spotify.com",
  "deezer.com",
]);

/**
 * The normalized provider host of an input that parses as a URL on an
 * allowlisted host, else null.
 *
 * The host question only. Nothing is read from the path or query, so this
 * extracts no resource identity and cannot become a second parser: callers
 * that need an id still go through `detectSource`. What it is for is
 * classification — telling "a provider link we cannot read" (a truncated id,
 * an `/artist/` URL no parser accepts) apart from "a link to somewhere else"
 * — so an unsupported link gets a truthful message instead of being called
 * malformed, and so nothing outside the allowlist is ever described as an
 * Aurora link.
 */
export function providerHostOf(input: string): string | null {
  const url = parseUrl(input);
  if (!url) {
    return null;
  }
  const host = hostOf(url);
  return PROVIDER_HOSTS.has(host) ? host : null;
}

/**
 * Detects the provider source for a supported URL, or null for plain-text
 * queries, malformed URLs, and unsupported domains. Deterministic: parser
 * order cannot change the result because provider host sets are disjoint.
 */
export function detectSource(input: string): DetectedSource | null {
  return (
    parseYouTubeUrl(input) ?? parseSpotifyUrl(input) ?? parseDeezerUrl(input)
  );
}

/** True when the input is a supported provider URL. */
export function isSupportedInput(input: string): boolean {
  return detectSource(input) !== null;
}
