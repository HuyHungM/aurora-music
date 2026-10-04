import type { PrismaClient } from "@/generated/prisma/client";
import type { Album, Artist, Track } from "@/lib/domain";

export async function upsertArtist(
  db: PrismaClient,
  artist: Pick<Artist, "id" | "provider" | "name" | "image" | "bio" | "genres">,
): Promise<string> {
  const row = await db.artist.upsert({
    where: {
      provider_providerArtistId: {
        provider: artist.provider,
        providerArtistId: artist.id,
      },
    },
    create: {
      provider: artist.provider,
      providerArtistId: artist.id,
      name: artist.name,
      image: artist.image,
      bio: artist.bio,
      genres: artist.genres,
    },
    // IDENTITY-ONLY. `Artist` is a shared, unowned row (see the module
    // comment), and every production caller is fed an `Artist` that arrived
    // from a client payload. Writing `name`/`image`/`bio`/`genres` here is
    // therefore not a refresh — it is "the last account to touch this artist
    // decides what it is called, for every user and every anonymous visitor of
    // a shared playlist".
    //
    // There is no authoritative writer to refresh from: no provider read runs
    // on these paths, so nothing here can distinguish a genuine metadata
    // correction from a crafted payload. The only discriminator available is
    // the CALLER, and there is no caller distinction — every caller is a client.
    // So the update branch writes nothing. A legitimately better name is never
    // persisted; that is the deliberate cost of an unowned shared row, and it
    // is the same trade `streamUrl`/`previewUrl`/`metadata` already make.
    update: {},
  });
  return row.id;
}

/**
 * Upserts an album under an ALREADY-RESOLVED artist.
 *
 * Split from `upsertAlbum` because a caller that has just upserted the
 * artist has nothing left to gain from doing it again: `upsertTrack` resolves
 * `track.artistId`/`track.artistName` and then forwards those same two values
 * verbatim as the album's, so the nested call issued a byte-identical
 * `INSERT ... ON CONFLICT` round trip on every like, play and playlist-add.
 */
export async function upsertAlbumByArtistId(
  db: PrismaClient,
  album: Pick<Album, "id" | "provider" | "title" | "artwork" | "releaseDate">,
  artistId: string,
): Promise<string> {
  const row = await db.album.upsert({
    where: {
      provider_providerAlbumId: {
        provider: album.provider,
        providerAlbumId: album.id,
      },
    },
    create: {
      provider: album.provider,
      providerAlbumId: album.id,
      name: album.title,
      artistId,
      image: album.artwork,
      releaseDate: album.releaseDate,
    },
    // IDENTITY-ONLY, for the same reason as `upsertArtist`: an `Album` is a
    // shared, unowned row and its display fields are attacker-reachable through
    // any client payload that names an `albumId`.
    //
    // This branch used to write `name: album.title`, where `upsertTrack` passes
    // `track.albumName ?? "Unknown album"` — so a payload carrying an `albumId`
    // with no album name renamed that album, for the whole product, to a literal
    // placeholder. `artistId` was in the same branch, letting a payload re-parent
    // an album globally. Neither is recoverable now that they have been written.
    update: {},
  });
  return row.id;
}

export async function upsertAlbum(
  db: PrismaClient,
  album: Pick<Album, "id" | "provider" | "title" | "artistId" | "artistName" | "artwork" | "releaseDate">,
): Promise<string> {
  const artistId = await upsertArtist(db, {
    id: album.artistId,
    provider: album.provider,
    name: album.artistName,
  });
  return upsertAlbumByArtistId(db, album, artistId);
}

/**
 * Shared, unowned catalog rows. There is no owner column, so there is
 * nothing to authorize a write against - which makes the WRITE PATH the
 * only trust boundary that exists here.
 *
 * `streamUrl`, `previewUrl` and `metadata` are deliberately NOT accepted.
 * Every production caller of this function is fed a `Track` that arrived
 * from a client payload (`likeTrackAction`, `recordPlayedAction`,
 * `addTrackToPlaylistAction` - see `dal/like.ts`, `dal/recently-played.ts`,
 * `dal/playlist.ts`). Accepting them let any authenticated user overwrite a
 * catalog row that every other user, and every anonymous visitor of a
 * shared playlist, then reads back.
 *
 * A media URL is not needed here either: playback resolves a fresh
 * `AudioSource` per load through `PlaybackController` and the controller
 * never reads `streamUrl`/`previewUrl` as playback input
 * (`playback/controller.ts`: "not even as a fallback"). Temporary playback
 * URLs are memory-only by design (`docs/security.md`), and this is the one
 * path that was still able to persist them.
 */
export async function upsertTrack(
  db: PrismaClient,
  track: Pick<
    Track,
    | "id"
    | "provider"
    | "title"
    | "artistId"
    | "artistName"
    | "albumId"
    | "albumName"
    | "artworkUrl"
    | "duration"
    | "genres"
    | "releaseDate"
    | "providerUrl"
    | "explicit"
  >,
): Promise<string> {
  const artistId = await upsertArtist(db, {
    id: track.artistId,
    provider: track.provider,
    name: track.artistName,
  });

  let albumId: string | undefined;
  if (track.albumId) {
    // The artist row above is already resolved, and this album's artist is
    // that same row — so it is passed through rather than upserted again.
    albumId = await upsertAlbumByArtistId(
      db,
      {
        id: track.albumId,
        provider: track.provider,
        title: track.albumName ?? "Unknown album",
      },
      artistId,
    );
  }

  const row = await db.track.upsert({
    where: {
      provider_providerTrackId: {
        provider: track.provider,
        providerTrackId: track.id,
      },
    },
    // `streamUrl`, `previewUrl` and `metadata` are intentionally absent in
    // both branches: see the doc comment above. On create they stay NULL;
    // on update an existing row keeps whatever it already had, so a client
    // payload can no longer overwrite them.
    create: {
      provider: track.provider,
      providerTrackId: track.id,
      title: track.title,
      artistId,
      albumId,
      duration: track.duration,
      artworkUrl: track.artworkUrl,
      genres: track.genres,
      releaseDate: track.releaseDate,
      providerUrl: track.providerUrl,
      explicit: track.explicit,
    },
    // IDENTITY-ONLY, for the reason given on `upsertArtist`'s update branch.
    //
    // This branch used to write nine client-supplied fields — `title`,
    // `artistId`, `albumId`, `duration`, `artworkUrl`, `genres`, `releaseDate`,
    // `providerUrl`, `explicit` — onto a shared, unowned row keyed only by
    // `(provider, providerTrackId)`. Any authenticated account could therefore
    // permanently rewrite any track's title and artwork as seen by every user of
    // the product and by every anonymous visitor of a shared playlist, by
    // calling `likeTrackAction` with a crafted `track`. `streamUrl` was excluded
    // from this branch for exactly this reason; the display fields were the same
    // hole with a different payload.
    //
    // `albumId` and `artistId` are excluded too, and that is the sharper half:
    // they are relations, so overwriting them re-points the track at a different
    // Artist or Album row for everyone.
    update: {},
  });
  return row.id;
}

export async function findTrackInternalId(
  db: PrismaClient,
  ref: { provider: string; providerTrackId: string },
): Promise<string | null> {
  const row = await db.track.findUnique({
    where: {
      provider_providerTrackId: {
        provider: ref.provider,
        providerTrackId: ref.providerTrackId,
      },
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function findArtistInternalId(
  db: PrismaClient,
  ref: { provider: string; providerArtistId: string },
): Promise<string | null> {
  const row = await db.artist.findUnique({
    where: {
      provider_providerArtistId: {
        provider: ref.provider,
        providerArtistId: ref.providerArtistId,
      },
    },
    select: { id: true },
  });
  return row?.id ?? null;
}