import type { PrismaClient, Prisma } from "@/generated/prisma/client";
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
    | "streamUrl"
    | "previewUrl"
    | "duration"
    | "genres"
    | "releaseDate"
    | "providerUrl"
    | "explicit"
    | "metadata"
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
    create: {
      provider: track.provider,
      providerTrackId: track.id,
      title: track.title,
      artistId,
      albumId,
      duration: track.duration,
      artworkUrl: track.artworkUrl,
      streamUrl: track.streamUrl,
      previewUrl: track.previewUrl,
      genres: track.genres,
      releaseDate: track.releaseDate,
      providerUrl: track.providerUrl,
      explicit: track.explicit,
      metadata: toJsonValue(track.metadata),
    },
    update: {
      title: track.title,
      artistId,
      albumId,
      duration: track.duration,
      artworkUrl: track.artworkUrl,
      streamUrl: track.streamUrl,
      previewUrl: track.previewUrl,
      genres: track.genres,
      releaseDate: track.releaseDate,
      providerUrl: track.providerUrl,
      explicit: track.explicit,
      metadata: toJsonValue(track.metadata),
    },
  });
  return row.id;
}

export function toJsonValue(
  value: unknown,
): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value as Prisma.InputJsonValue;
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