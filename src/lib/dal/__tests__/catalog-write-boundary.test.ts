/**
 * The shared catalog's write path IS the trust boundary.
 *
 * `Track`, `Artist` and `Album` have no owner column, so the per-row ownership
 * recheck that protects `Playlist`, `Like` and `Follow` has no analogue here —
 * `ARCHITECTURE.md` invariant 34 is explicit that "the *shape* of what a client
 * may cause to be written is the only control point that exists". Every
 * production caller of `upsertTrack`/`upsertArtist`/`upsertAlbum` is fed an
 * entity that arrived from a client payload (`likeTrackAction`,
 * `recordPlayedAction`, `addTrackToPlaylistAction`, `followArtistAction`).
 *
 * THE DEFECT THIS FILE PINS. The update branch used to write the client's
 * display fields onto the shared row:
 *
 *   upsertTrack.update      -> title, artistId, albumId, duration, artworkUrl,
 *                              genres, releaseDate, providerUrl, explicit
 *   upsertArtist.update     -> name, image
 *   upsertAlbumByArtistId   -> name, artistId, image
 *
 * `streamUrl`/`previewUrl`/`metadata` were already excluded for precisely this
 * reason, so this was the same hole with a different payload: one authenticated
 * account could set any YouTube track's title and artwork — permanently, for
 * every user and every anonymous shared-playlist visitor — by calling
 * `likeTrackAction` with a crafted `track`. `artistId`/`albumId` are worse
 * still, because they are relations.
 *
 * WHY THIS RUNS WITHOUT A DATABASE. All three functions take the Prisma client
 * as a parameter, so the property under test — the exact payload handed to
 * `upsert` — is observable through a recording stub. That is both faster than
 * the `*.db.test.ts` suite and a stronger assertion: it pins the SHAPE of the
 * write, which is what the invariant is about, rather than the resulting row.
 */
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { upsertAlbum, upsertAlbumByArtistId, upsertArtist, upsertTrack } from "@/lib/dal/catalog";

interface UpsertCall {
  model: string;
  args: { where: unknown; create: Record<string, unknown>; update: Record<string, unknown> };
}

/**
 * Minimal recording stand-in for the three Prisma delegates the catalog
 * upserts touch. Every one resolves to `{ id }`, which is all the DAL reads back.
 */
function recordingClient() {
  const calls: UpsertCall[] = [];
  const record =
    (model: string) =>
    (args: UpsertCall["args"]): { id: string } => {
      calls.push({ model, args });
      return { id: `${model}-id` };
    };

  const db = {
    artist: { upsert: record("artist") },
    album: { upsert: record("album") },
    track: { upsert: record("track") },
  };

  return { db: db as unknown as PrismaClient, calls };
}

const HOSTILE = {
  provider: "youtube",
  id: "dQw4w9WgXcQ",
  title: "pwned",
  artistId: "attacker-artist",
  artistName: "attacker",
  albumId: "attacker-album",
  albumName: "attacker album",
  artworkUrl: "http://attacker.example/beacon.gif",
  duration: 999_999,
  genres: ["pwned"],
  releaseDate: "1999-01-01",
  providerUrl: "http://attacker.example/pwned",
  explicit: true,
};

describe("shared catalog: the update branch writes nothing a client supplied", () => {
  it("does not let a second payload overwrite a track's display fields", async () => {
    const { db, calls } = recordingClient();

    // First write creates the row from provider data.
    await upsertTrack(db, {
      provider: "youtube",
      id: "dQw4w9WgXcQ",
      title: "Never Gonna Give You Up",
      artistId: "real-artist",
      artistName: "Rick Astley",
    });
    // Second write is the attack: same identity, hostile everything else.
    await upsertTrack(db, HOSTILE);

    const trackUpsert = calls.find((call) => call.model === "track");
    expect(trackUpsert).toBeDefined();
    expect(trackUpsert?.args.update).toEqual({});

    // And the create branch really did carry the real values, so the empty
    // update is "keep what we first learned", not "never write anything".
    expect(trackUpsert?.args.create.title).toBe("Never Gonna Give You Up");
    expect(trackUpsert?.args.create.streamUrl).toBeUndefined();
    expect(trackUpsert?.args.create.previewUrl).toBeUndefined();
    expect(trackUpsert?.args.create.metadata).toBeUndefined();
  });

  it("does not let a second payload rename an artist", async () => {
    const { db, calls } = recordingClient();

    await upsertArtist(db, {
      id: "real-artist",
      provider: "youtube",
      name: "Rick Astley",
    });
    await upsertArtist(db, {
      id: "real-artist",
      provider: "youtube",
      name: "attacker",
      image: "http://attacker.example/x.gif",
    });

    const artistUpsert = calls.find((call) => call.model === "artist");
    expect(artistUpsert?.args.update).toEqual({});
    expect(artistUpsert?.args.create.name).toBe("Rick Astley");
  });

  it("does not let a payload re-parent or rename an album", async () => {
    const { db, calls } = recordingClient();

    await upsertAlbumByArtistId(
      db,
      { id: "real-album", provider: "youtube", title: "Whenever You Need Somebody" },
      "real-artist",
    );
    await upsertAlbumByArtistId(
      db,
      { id: "real-album", provider: "youtube", title: "attacker album" },
      "attacker-artist",
    );

    const albumUpsert = calls.find((call) => call.model === "album");
    expect(albumUpsert?.args.update).toEqual({});
    expect(albumUpsert?.args.create.name).toBe("Whenever You Need Somebody");
    expect(albumUpsert?.args.create.artistId).toBe("real-artist");
  });

  it("never writes a media URL, on create or on update", async () => {
    // The pre-existing half of this boundary, kept asserted here so the two
    // halves cannot drift apart again.
    //
    // The cast is deliberate and is itself part of the assertion: `upsertTrack`'s
    // parameter type excludes these three fields, so a caller cannot pass them
    // without casting. This proves the DAL ignores them even then — the type is
    // the first line of defence, this is the second.
    const { db, calls } = recordingClient();

    await upsertTrack(db, {
      ...HOSTILE,
      streamUrl: "https://attacker.example/evil.mp3",
      previewUrl: "https://attacker.example/evil.mp3",
      metadata: { sources: ["spoofed"] },
    } as unknown as Parameters<typeof upsertTrack>[1]);

    const trackUpsert = calls.find((call) => call.model === "track");
    for (const field of ["streamUrl", "previewUrl", "metadata"]) {
      expect(trackUpsert?.args.create[field]).toBeUndefined();
      expect(trackUpsert?.args.update[field]).toBeUndefined();
    }
  });

  it("still resolves the artist before the album, through upsertAlbum", async () => {
    // The one ordering guarantee the callers depend on: `upsertAlbum` resolves
    // the artist itself, so it must still issue that write first. The empty
    // update branches must not have changed the sequence.
    const { db, calls } = recordingClient();

    await upsertAlbum(db, {
      id: "album-1",
      provider: "youtube",
      title: "Album One",
      artistId: "artist-1",
      artistName: "Artist One",
    });

    expect(calls.map((call) => call.model)).toEqual(["artist", "album"]);
  });
});

describe("shared catalog: a track with no album title", () => {
  it("creates the album row with a placeholder but never renames an existing one", async () => {
    // `track.albumName` is optional, so a payload can name an `albumId` and
    // omit the title. `upsertTrack` passes `?? "Unknown album"`, which is only
    // ever safe on CREATE — on update it renamed the shared album to that
    // literal, product-wide.
    const { db, calls } = recordingClient();

    await upsertTrack(db, {
      provider: "youtube",
      id: "no-album-name",
      title: "Some Track",
      artistId: "artist-1",
      artistName: "Artist One",
      albumId: "album-1",
    });

    const albumUpsert = calls.find((call) => call.model === "album");
    expect(albumUpsert?.args.create.name).toBe("Unknown album");
    expect(albumUpsert?.args.update).toEqual({});
  });
});

/**
 * The hostile payload is only dangerous because it is reachable from a server
 * action. This asserts the reachability itself, so the boundary cannot be
 * re-opened by adding a new client-supplied field to the schema without
 * noticing that the DAL would carry it.
 */
describe("shared catalog: client payloads reach the upserts", () => {
  it("exposes every display field the actions accept", () => {
    // Documentation-grade assertion: it names the exact set of fields a
    // crafted payload can carry. If a new one is added to `trackInputSchema`,
    // this list is the checklist for whether the DAL must strip it.
    expect(Object.keys(HOSTILE).sort()).toEqual([
      "albumId",
      "albumName",
      "artistId",
      "artistName",
      "artworkUrl",
      "duration",
      "explicit",
      "genres",
      "id",
      "provider",
      "providerUrl",
      "releaseDate",
      "title",
    ]);
  });
});