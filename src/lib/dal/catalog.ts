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
    update: {
      name: artist.name,
      image: artist.image,
    },
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
    update: {
      name: album.title,
      artistId,
      image: album.artwork,
    },
  });
  return row.id;
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
    albumId = await upsertAlbum(db, {
      id: track.albumId,
      provider: track.provider,
      title: track.albumName ?? "Unknown album",
      artistId: track.artistId,
      artistName: track.artistName,
    });
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
    update: {
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