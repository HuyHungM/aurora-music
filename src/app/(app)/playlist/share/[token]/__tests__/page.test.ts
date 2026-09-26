import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedPlaylist } from "@/lib/domain";
import { SHARE_TOKEN_LENGTH } from "@/lib/validation";

/**
 * Phase 47 public share route: the security boundary.
 *
 * This route is the only unauthenticated read of playlist data in the
 * product, so the properties asserted here are the whole point of the
 * feature:
 *
 *   1. A valid, shared token renders, WITHOUT a session.
 *   2. A private playlist is unreachable — including by guessing its exact
 *      database id, and including a token that merely LOOKS right.
 *   3. A revoked playlist stops resolving, so an old link dies.
 *   4. A malformed or forged token never reaches the database.
 *   5. Nothing private is exposed: not in the rendered element, not in the
 *      metadata, and not in the shareable token.
 *   6. A failure is indistinguishable from a miss, so a probe cannot
 *      distinguish "private" from "wrong token".
 */

const NOT_FOUND = "NEXT_NOT_FOUND";

/**
 * Records whether the route ever imports the session module at all. If the
 * route grew a session dependency, this factory would run and the test below
 * would fail — which is the point: this route is deliberately the product's
 * only unauthenticated playlist read, and neither a gate (sharing would be
 * meaningless) nor a leak (an owner-only read opened to the world) is right.
 */
const { sessionFactory } = vi.hoisted(() => ({ sessionFactory: vi.fn() }));

vi.mock("@/lib/dal/session", () => {
  sessionFactory();
  return { requireUser: vi.fn(), getSessionUserId: vi.fn() };
});

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));

vi.mock("@/lib/dal/playlist", () => ({
  getSharedPlaylistByToken: vi.fn(),
  getSharedPlaylistTracks: vi.fn(),
}));

vi.mock("@/lib/i18n/server", () => ({
  getRequestLocale: vi.fn(async () => "en"),
}));

vi.mock("@/components/playlist/shared-playlist-view", () => ({
  SharedPlaylistView: vi.fn(() => null),
}));

import { getSharedPlaylistByToken, getSharedPlaylistTracks } from "@/lib/dal/playlist";
import { SharedPlaylistView } from "@/components/playlist/shared-playlist-view";
import {
  default as SharedPlaylistPage,
  generateMetadata,
} from "@/app/(app)/playlist/share/[token]/page";

const VALID_TOKEN = "a".repeat(SHARE_TOKEN_LENGTH);

const sharedPlaylist: SharedPlaylist = {
  title: "Road Trip",
  description: "Long drives",
  artwork: "https://img.example/cover.jpg",
  ownerDisplayName: "Nova",
  items: [
    { id: "pi1", trackId: "yt-1", provider: "youtube" },
    { id: "pi2", trackId: "yt-2", provider: "youtube" },
  ],
};

const tracks = [
  {
    id: "yt-1",
    provider: "youtube" as const,
    providerTrackId: "yt-1",
    title: "First",
    artistId: "a1",
    artistName: "Artist One",
    duration: 200,
  },
  {
    id: "yt-2",
    provider: "youtube" as const,
    providerTrackId: "yt-2",
    title: "Second",
    artistId: "a1",
    artistName: "Artist One",
    duration: 210,
  },
];

function params(token: string) {
  return { params: Promise.resolve({ token }) };
}

/**
 * The props the route handed to the view. That is exactly the data the route
 * decided to expose publicly, so it is the right thing to assert on — no
 * render, no DOM, no serialization step that could hide a field.
 */
async function render(token: string) {
  const element = (await SharedPlaylistPage(params(token))) as unknown as {
    props: { playlist: SharedPlaylist; tracks: unknown[] };
  };
  return element.props;
}

async function renderExpecting404(token: string) {
  await expect(SharedPlaylistPage(params(token))).rejects.toThrow(NOT_FOUND);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSharedPlaylistByToken).mockResolvedValue(sharedPlaylist);
  vi.mocked(getSharedPlaylistTracks).mockResolvedValue(tracks);
});

describe("shared playlist route: a valid token renders without a session", () => {
  it("renders the playlist and its tracks", async () => {
    const result = await render(VALID_TOKEN);
    expect(result.playlist.title).toBe("Road Trip");
    expect(result.tracks).toHaveLength(2);
  });

  // The route must not consult the session at all: it is the product's only
  // unauthenticated playlist read, and an owner-only gate here would make
  // sharing meaningless while a stray gate would leak.
  it("never imports the session module at all", async () => {
    await render(VALID_TOKEN);
    expect(sessionFactory).not.toHaveBeenCalled();
  });

  it("passes the custom artwork through to the view", async () => {
    const result = await render(VALID_TOKEN);
    expect(result.playlist.artwork).toBe("https://img.example/cover.jpg");
  });

  it("renders a playlist with no custom artwork (default fallback)", async () => {
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue({
      title: "No Art",
      ownerDisplayName: "Nova",
      items: [],
    });
    const result = await render(VALID_TOKEN);
    expect(result.playlist.artwork).toBeUndefined();
  });

  it("renders a shared playlist that has no tracks", async () => {
    vi.mocked(getSharedPlaylistTracks).mockResolvedValue([]);
    const result = await render(VALID_TOKEN);
    expect(result.tracks).toEqual([]);
  });

  it("serves the owner's CURRENT tracks, not a frozen snapshot", async () => {
    // §69: a shared playlist stays a live shared collection. Adding a track
    // after sharing must be visible to the viewer immediately.
    vi.mocked(getSharedPlaylistTracks).mockResolvedValue([
      ...tracks,
      { ...tracks[0], id: "yt-3", providerTrackId: "yt-3", title: "Added Later" },
    ]);
    const result = await render(VALID_TOKEN);
    expect(result.tracks).toHaveLength(3);
  });
});

describe("shared playlist route: a private playlist is unreachable", () => {
  it("404s when the playlist is not shared", async () => {
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue(null);
    await renderExpecting404(VALID_TOKEN);
  });

  // §18: the specific attack is guessing a database id in the URL. Two cases
  // matter and they are defended at two different layers.
  it("404s a real cuid-shaped id without ever querying the database", async () => {
    // A real Prisma id is 25 characters, so it fails the token shape check
    // and never becomes a query at all.
    const realCuid = "cmey1234567890abcdefghijkl";
    expect(realCuid).not.toHaveLength(SHARE_TOKEN_LENGTH);
    await renderExpecting404(realCuid);
    expect(getSharedPlaylistByToken).not.toHaveBeenCalled();
  });

  it("404s an id-shaped token that reaches the DAL but is not shared", async () => {
    // Even padded to the exact token shape, the query requires
    // `visibility = "shared"`, so a private playlist cannot be reached by
    // supplying its id in any form.
    const padded = "cmey1234567890abcdefghijkl".padEnd(SHARE_TOKEN_LENGTH, "q");
    expect(padded).toHaveLength(SHARE_TOKEN_LENGTH);
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue(null);
    await renderExpecting404(padded);
    expect(getSharedPlaylistByToken).toHaveBeenCalledWith(padded);
  });

  it("404s for a revoked playlist whose old link is still held", async () => {
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue(null);
    await renderExpecting404(VALID_TOKEN);
  });

  it("404s when the playlist was deleted", async () => {
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue(null);
    vi.mocked(getSharedPlaylistTracks).mockResolvedValue([]);
    await renderExpecting404(VALID_TOKEN);
  });
});

describe("shared playlist route: malformed and forged tokens", () => {
  it("404s a token of the wrong length", async () => {
    for (const token of ["", "a", "a".repeat(SHARE_TOKEN_LENGTH - 1), "a".repeat(SHARE_TOKEN_LENGTH + 1)]) {
      await renderExpecting404(token);
    }
  });

  it("404s a token with characters outside the base64url alphabet", async () => {
    for (const bad of ["+", "/", "=", "!", "..", " ", "%2e%2e", "é", " "]) {
      await renderExpecting404("a".repeat(SHARE_TOKEN_LENGTH - 1) + bad);
    }
  });

  // Shape validation exists so a hostile token never becomes a query. If the
  // schema were bypassed, every one of these would hit the DAL.
  it("never sends a malformed token to the database", async () => {
    for (const token of [
      "",
      "../../etc/passwd",
      "<script>alert(1)</script>",
      "' OR 1=1 --",
      "a".repeat(5000),
      "a".repeat(SHARE_TOKEN_LENGTH - 1) + "/",
    ]) {
      await renderExpecting404(token);
    }
    expect(getSharedPlaylistByToken).not.toHaveBeenCalled();
    expect(getSharedPlaylistTracks).not.toHaveBeenCalled();
  });
});

describe("shared playlist route: no private data is exposed", () => {
  it("exposes no owner id and no reusable token to the view", async () => {
    const result = await render(VALID_TOKEN);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ownerId");
    expect(serialized).not.toContain("userId");
    expect(serialized).not.toContain("shareToken");
    expect(Object.keys(result.playlist).sort()).toEqual([
      "artwork",
      "description",
      "items",
      "ownerDisplayName",
      "title",
    ]);
  });

  it("exposes no ownership data through the metadata either", async () => {
    const metadata = await generateMetadata(params(VALID_TOKEN));
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain("ownerId");
    expect(serialized).not.toContain("shareToken");
    expect(serialized).not.toContain(VALID_TOKEN);
  });

  it("gives a 404 the SAME metadata as a private playlist", async () => {
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue(null);
    const metadata = await generateMetadata(params(VALID_TOKEN));
    expect(metadata.title).not.toBe(sharedPlaylist.title);
    expect(metadata.robots).toEqual({ index: false });
    // No description either: a probe learns nothing about what it missed.
    expect(metadata.description).toBeUndefined();
  });

  it("gives a malformed token the same 404 metadata as a miss", async () => {
    const wrong = await generateMetadata(params("too-short"));
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue(null);
    const missed = await generateMetadata(params(VALID_TOKEN));
    expect(wrong).toEqual(missed);
  });

  it("marks a resolvable shared playlist indexable and uses its artwork", async () => {
    const metadata = await generateMetadata(params(VALID_TOKEN));
    expect(metadata.title).toBe("Road Trip");
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.openGraph?.images).toEqual([
      { url: "https://img.example/cover.jpg" },
    ]);
  });

  it("omits OpenGraph images when there is no custom artwork", async () => {
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue({
      title: "No Art",
      ownerDisplayName: "Nova",
      items: [],
    });
    const metadata = await generateMetadata(params(VALID_TOKEN));
    expect(metadata.openGraph?.images).toBeUndefined();
  });

  it("falls back to an author line in the description", async () => {
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue({
      title: "No Description",
      ownerDisplayName: "Nova",
      items: [],
    });
    const metadata = await generateMetadata(params(VALID_TOKEN));
    expect(metadata.description).toContain("Nova");
  });

  it("does not throw when the metadata lookup fails", async () => {
    vi.mocked(getSharedPlaylistByToken).mockRejectedValue(new Error("db down"));
    const metadata = await generateMetadata(params(VALID_TOKEN));
    expect(metadata.robots).toEqual({ index: false });
  });

  it("404s rather than redirecting to sign-in", async () => {
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue(null);
    await expect(SharedPlaylistPage(params(VALID_TOKEN))).rejects.toThrow(NOT_FOUND);
    // Exactly one view render, zero: a redirect to sign-in would both leak
    // existence and break the plain-404 contract the revoked case relies on.
    expect(vi.mocked(SharedPlaylistView)).not.toHaveBeenCalled();
  });

  it("404s without rendering the view even when the tracks query resolves", async () => {
    // The tracks query runs in parallel and may well succeed for a token
    // that the playlist query refuses. It must not rescue the render.
    vi.mocked(getSharedPlaylistByToken).mockResolvedValue(null);
    vi.mocked(getSharedPlaylistTracks).mockResolvedValue(tracks);
    await renderExpecting404(VALID_TOKEN);
    expect(vi.mocked(SharedPlaylistView)).not.toHaveBeenCalled();
  });
});
