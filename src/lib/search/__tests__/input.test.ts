import { describe, expect, it } from "vitest";
import { detectSource, providerHostOf } from "@/lib/providers/source-detection";
import {
  canonicalSearchInput,
  canonicalSourceUrl,
  classifySearchInput,
  looksLikeUrl,
  providerDisplayName,
  searchInputKind,
} from "@/lib/search/input";

/**
 * The detection half of the link-search matrix (§15 of the feature report).
 *
 * The invariant under every case here is the same: classification happens
 * BEFORE any network call, and it is the only thing that decides whether an
 * input becomes a provider lookup, a text search, or an error. Nothing in
 * this file is allowed to need a provider to answer.
 */

const YT_ID = "dQw4w9WgXcQ";
const SPOTIFY_ID = "4uLU6hMCjMI75M1A2tKUQ3";
const DEEZER_ID = "3135556";

function source(input: string) {
  const result = classifySearchInput(input);
  if (result.kind !== "source") {
    throw new Error(`expected "${input}" to be a source, got ${result.kind}`);
  }
  return result.source;
}

function unsupported(input: string) {
  const result = classifySearchInput(input);
  if (result.kind !== "unsupported-url") {
    throw new Error(`expected "${input}" to be unsupported, got ${result.kind}`);
  }
  return result;
}

describe("classifySearchInput — text keeps behaving like text", () => {
  it("treats a plain phrase as a query", () => {
    expect(classifySearchInput("Lạc Trôi")).toEqual({
      kind: "query",
      query: "Lạc Trôi",
    });
  });

  it("treats punctuated prose as a query, not as a URL", () => {
    // The whole reason `looksLikeUrl` also requires a single token with an
    // http(s) scheme: punctuation in ordinary language must not route a
    // search into the link path or into an error.
    for (const prose of ["What's up?", "remix (2024)", "feat. someone, live"]) {
      expect(classifySearchInput(prose).kind).toBe("query");
    }
  });

  it("treats prose that merely CONTAINS a link as a query", () => {
    const input = `listen to https://youtu.be/${YT_ID} later`;
    expect(classifySearchInput(input)).toEqual({
      kind: "query",
      query: input,
    });
  });

  it("trims the query but preserves internal spacing", () => {
    expect(classifySearchInput("  Sơn Tùng M-TP  ")).toEqual({
      kind: "query",
      query: "Sơn Tùng M-TP",
    });
  });

  it("treats an empty input as an empty query", () => {
    expect(classifySearchInput("   ")).toEqual({ kind: "query", query: "" });
  });

  it("requires an explicit http(s) scheme", () => {
    expect(looksLikeUrl(`youtu.be/${YT_ID}`)).toBe(false);
    expect(looksLikeUrl(`https://youtu.be/${YT_ID}`)).toBe(true);
    expect(looksLikeUrl(`http://youtu.be/${YT_ID}`)).toBe(true);
    expect(looksLikeUrl(`ftp://youtu.be/${YT_ID}`)).toBe(false);
  });
});

describe("classifySearchInput — supported provider links", () => {
  it("classifies Spotify track, album and playlist links", () => {
    expect(source(`https://open.spotify.com/track/${SPOTIFY_ID}`)).toMatchObject({
      provider: "spotify",
      kind: "track",
      id: SPOTIFY_ID,
    });
    expect(source(`https://open.spotify.com/album/${SPOTIFY_ID}`)).toMatchObject({
      provider: "spotify",
      kind: "album",
      id: SPOTIFY_ID,
    });
    expect(source(`https://open.spotify.com/playlist/${SPOTIFY_ID}`)).toMatchObject({
      provider: "spotify",
      kind: "playlist",
      id: SPOTIFY_ID,
    });
  });

  it("classifies every supported YouTube host and shape", () => {
    for (const url of [
      `https://www.youtube.com/watch?v=${YT_ID}`,
      `https://youtube.com/watch?v=${YT_ID}`,
      `https://music.youtube.com/watch?v=${YT_ID}`,
      `https://youtu.be/${YT_ID}`,
      `https://www.youtube.com/embed/${YT_ID}`,
      `https://www.youtube.com/shorts/${YT_ID}`,
    ]) {
      expect(source(url)).toMatchObject({ provider: "youtube", kind: "track", id: YT_ID });
    }
    expect(source("https://www.youtube.com/playlist?list=PLabc")).toMatchObject({
      provider: "youtube",
      kind: "playlist",
      id: "PLabc",
    });
  });

  it("classifies Deezer track, album and playlist links", () => {
    expect(source(`https://www.deezer.com/track/${DEEZER_ID}`)).toMatchObject({
      provider: "deezer",
      kind: "track",
      id: DEEZER_ID,
    });
    expect(source(`https://deezer.com/album/${DEEZER_ID}`)).toMatchObject({
      provider: "deezer",
      kind: "album",
      id: DEEZER_ID,
    });
    expect(source(`https://www.deezer.com/playlist/${DEEZER_ID}`)).toMatchObject({
      provider: "deezer",
      kind: "playlist",
      id: DEEZER_ID,
    });
  });

  it("ignores tracking and playback query parameters", () => {
    expect(
      source(`https://youtu.be/${YT_ID}?si=abc123&list=PLzz&t=42&feature=share`),
    ).toMatchObject({ id: YT_ID });
    expect(
      source(`https://open.spotify.com/track/${SPOTIFY_ID}?si=zzz`),
    ).toMatchObject({ id: SPOTIFY_ID });
    expect(
      source(`https://open.spotify.com/intl-de/track/${SPOTIFY_ID}`),
    ).toMatchObject({ id: SPOTIFY_ID });
  });

  it("maps to the documented SearchInputKind values", () => {
    expect(searchInputKind(classifySearchInput("hello"))).toBe("query");
    expect(searchInputKind(classifySearchInput("https://example.com/1"))).toBe(
      "unsupported-url",
    );
    expect(
      searchInputKind(classifySearchInput(`https://open.spotify.com/track/${SPOTIFY_ID}`)),
    ).toBe("spotify-track");
    expect(
      searchInputKind(classifySearchInput(`https://open.spotify.com/album/${SPOTIFY_ID}`)),
    ).toBe("spotify-album");
    expect(
      searchInputKind(classifySearchInput(`https://open.spotify.com/playlist/${SPOTIFY_ID}`)),
    ).toBe("spotify-playlist");
    expect(
      searchInputKind(classifySearchInput(`https://youtu.be/${YT_ID}`)),
    ).toBe("youtube-track");
    expect(
      searchInputKind(classifySearchInput("https://www.youtube.com/playlist?list=PL1")),
    ).toBe("youtube-playlist");
    expect(
      searchInputKind(classifySearchInput(`https://www.deezer.com/track/${DEEZER_ID}`)),
    ).toBe("deezer-track");
  });
});

describe("classifySearchInput — unsupported links never fall through", () => {
  it("reports a foreign host as unsupported-host", () => {
    expect(unsupported("https://example.com/watch?v=abc").reason).toBe(
      "unsupported-host",
    );
    expect(unsupported(`https://spotify.com/track/${SPOTIFY_ID}`).reason).toBe(
      "unsupported-host",
    );
    expect(unsupported("https://www.jamendo.com/track/123").reason).toBe(
      "unsupported-host",
    );
  });

  it("reports an allowlisted host with an unreadable resource as malformed", () => {
    // Artist and channel resources have no parser: recognised host, wrong
    // resource type. They must be refused rather than sent to the text search.
    expect(
      unsupported(`https://open.spotify.com/artist/${SPOTIFY_ID}`).reason,
    ).toBe("malformed");
    expect(unsupported("https://www.youtube.com/channel/UC123").reason).toBe(
      "malformed",
    );
    expect(
      unsupported(`https://www.youtube.com/watch?v=tooshort`).reason,
    ).toBe("malformed");
    expect(unsupported("https://open.spotify.com/track/short").reason).toBe(
      "malformed",
    );
    expect(unsupported("https://").reason).toBe("malformed");
  });

  it("never treats a non-http scheme as a provider link", () => {
    // `javascript:` and `data:` do not match the http(s) requirement, so they
    // stay prose and go through ordinary text search. No scheme other than
    // http(s) can therefore reach the link resolver, and no user input is
    // ever opened as a URL.
    expect(classifySearchInput("javascript:alert(1)").kind).toBe("query");
    expect(classifySearchInput("data:text/html,<b>x</b>").kind).toBe("query");
    expect(unsupported("https://javascript.example/1").reason).toBe(
      "unsupported-host",
    );
  });

  it("keeps the offending URL so the page can describe what it saw", () => {
    expect(unsupported("https://example.com/a?b=1").url).toBe(
      "https://example.com/a?b=1",
    );
  });
});

describe("providerHostOf — the host allowlist, reused rather than copied", () => {
  it("accepts only the hosts the parsers accept", () => {
    expect(providerHostOf("https://www.youtube.com/watch?v=abc")).toBe("youtube.com");
    expect(providerHostOf("https://music.youtube.com/watch?v=abc")).toBe(
      "music.youtube.com",
    );
    expect(providerHostOf("https://youtu.be/abc")).toBe("youtu.be");
    expect(providerHostOf("https://open.spotify.com/track/x")).toBe("open.spotify.com");
    expect(providerHostOf("https://www.deezer.com/track/1")).toBe("deezer.com");
  });

  it("rejects foreign hosts and non-URLs", () => {
    expect(providerHostOf("https://example.com/watch?v=abc")).toBeNull();
    expect(providerHostOf("https://spotify.com/track/x")).toBeNull();
    expect(providerHostOf("not a url")).toBeNull();
    expect(providerHostOf("")).toBeNull();
  });

  it("agrees with detectSource: a detected source always has an allowlisted host", () => {
    for (const url of [
      `https://youtu.be/${YT_ID}`,
      `https://open.spotify.com/track/${SPOTIFY_ID}`,
      `https://www.deezer.com/track/${DEEZER_ID}`,
      "https://www.youtube.com/playlist?list=PLabc",
    ]) {
      expect(detectSource(url)).not.toBeNull();
      expect(providerHostOf(url)).not.toBeNull();
    }
  });
});

describe("canonicalSearchInput — the normalized, re-submittable form", () => {
  it("rebuilds a canonical URL that carries no tracking parameters", () => {
    expect(
      canonicalSearchInput(`https://youtu.be/${YT_ID}?si=abc&list=PL&t=42&feature=share`),
    ).toBe(`https://www.youtube.com/watch?v=${YT_ID}`);
    expect(
      canonicalSearchInput(`https://open.spotify.com/intl-de/track/${SPOTIFY_ID}?si=x`),
    ).toBe(`https://open.spotify.com/track/${SPOTIFY_ID}`);
    expect(
      canonicalSearchInput(`https://www.deezer.com/us/track/${DEEZER_ID}`),
    ).toBe(`https://www.deezer.com/track/${DEEZER_ID}`);
    expect(
      canonicalSearchInput("https://music.youtube.com/playlist?list=PLxyz"),
    ).toBe("https://www.youtube.com/playlist?list=PLxyz");
  });

  it("is stable: every variant of one resource collapses to one string", () => {
    const forms = [
      `https://open.spotify.com/track/${SPOTIFY_ID}`,
      `https://open.spotify.com/track/${SPOTIFY_ID}?si=one`,
      `https://open.spotify.com/intl-fr/track/${SPOTIFY_ID}?si=two`,
      `https://www.open.spotify.com/track/${SPOTIFY_ID}`,
    ];
    expect(new Set(forms.map(canonicalSearchInput)).size).toBe(1);
  });

  it("round-trips through the detector (same provider, kind and id)", () => {
    for (const url of [
      `https://youtu.be/${YT_ID}?si=x`,
      `https://open.spotify.com/album/${SPOTIFY_ID}?si=y`,
      `https://www.deezer.com/playlist/${DEEZER_ID}`,
      "https://www.youtube.com/playlist?list=PLabc",
    ]) {
      const canonical = canonicalSearchInput(url);
      expect(canonical).not.toBe("");
      expect(detectSource(canonical)).toMatchObject({
        provider: source(url).provider,
        kind: source(url).kind,
        id: source(url).id,
      });
    }
  });

  it("passes a text query through unchanged (trimmed)", () => {
    expect(canonicalSearchInput("  What's up?  ")).toBe("What's up?");
  });

  it("returns nothing for an unsupported link, so nothing is recorded", () => {
    expect(canonicalSearchInput("https://example.com/watch?v=abc")).toBe("");
    expect(canonicalSearchInput(`https://open.spotify.com/artist/${SPOTIFY_ID}`)).toBe(
      "",
    );
  });

  it("builds the canonical URL from identity only", () => {
    expect(
      canonicalSourceUrl({
        provider: "youtube",
        kind: "playlist",
        id: "PLabc",
        url: "https://music.youtube.com/playlist?list=PLabc&si=noise",
      }),
    ).toBe("https://www.youtube.com/playlist?list=PLabc");
    expect(
      canonicalSourceUrl({
        provider: "spotify",
        kind: "playlist",
        id: SPOTIFY_ID,
        url: `https://open.spotify.com/playlist/${SPOTIFY_ID}?si=noise`,
      }),
    ).toBe(`https://open.spotify.com/playlist/${SPOTIFY_ID}`);
  });
});

describe("providerDisplayName", () => {
  it("spells brand names the same in every locale", () => {
    expect(providerDisplayName("spotify")).toBe("Spotify");
    expect(providerDisplayName("youtube")).toBe("YouTube");
    expect(providerDisplayName("deezer")).toBe("Deezer");
  });

  it("degrades to the raw id for an unknown provider rather than inventing one", () => {
    expect(providerDisplayName("something")).toBe("something");
  });
});
