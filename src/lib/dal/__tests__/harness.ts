import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Artist, Track } from "@/lib/domain";

function providerNamespace(): string {
  return `db-test-${randomUUID()}`;
}

async function createUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `${label}-${randomUUID()}@example.com` },
  });
  return user.id;
}

function makeArtist(providerNamespace: string, index: number): Artist {
  return {
    id: `artist-${index}`,
    provider: providerNamespace as Artist["provider"],
    name: `Artist ${index}`,
    image: `https://img/artist-${index}.jpg`,
    genres: ["rock"],
  };
}

function makeTrack(providerNamespace: string, index: number): Track {
  return {
    id: `track-${providerNamespace}-${index}`,
    provider: providerNamespace as Track["provider"],
    title: `Track ${index}`,
    artistId: `artist-${index}`,
    artistName: `Artist ${index}`,
    albumId: `album-${index}`,
    albumName: `Album ${index}`,
    artworkUrl: `https://img/track-${index}.jpg`,
    streamUrl: `https://stream/track-${index}.mp3`,
    previewUrl: `https://preview/track-${index}.mp3`,
    duration: 180 + index,
    genres: ["jazz", "blues"],
    releaseDate: "2026-01-01",
    providerUrl: `https://jamendo.com/track/${index}`,
    explicit: false,
    metadata: { popularity: index },
  };
}

async function cleanup(namespace: string): Promise<void> {
  await prisma.track.deleteMany({ where: { provider: { startsWith: namespace } } });
  await prisma.album.deleteMany({ where: { provider: { startsWith: namespace } } });
  await prisma.follow.deleteMany({
    where: { artist: { provider: { startsWith: namespace } } },
  });
  await prisma.artist.deleteMany({ where: { provider: { startsWith: namespace } } });
}

export const dbTest = {
  providerNamespace,
  createUser,
  makeArtist,
  makeTrack,
  cleanup,
  prisma,
};