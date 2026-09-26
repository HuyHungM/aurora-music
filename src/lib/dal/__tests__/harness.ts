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

/**
 * A track from a REAL source provider, for cross-provider dedupe tests.
 *
 * `makeTrack` deliberately uses a random namespace as its `provider`, which is
 * not one of the three production source types - so `toTrackIdentity` refuses
 * it and the canonical matcher can never see it. A test that needs the matcher
 * tier (the Spotify and Deezer renderings of ONE recording) therefore cannot
 * use `makeTrack`: it needs a real provider AND a namespaced id, so
 * `cleanup` can still find and remove the row.
 *
 * `group` is the logical recording: tracks sharing a group number carry the
 * same title, artist and duration, so the matcher sees one song. `index`
 * makes the provider-scoped id unique, because two rows with the same
 * `(provider, providerTrackId)` would be the same row, not two renderings.
 */
function makeProviderTrack(
  providerNamespace: string,
  provider: "youtube" | "spotify" | "deezer",
  group: number,
  index: number,
): Track {
  // The id carries the GROUP as well as the index, so two recordings never
  // share a provider id even when a test file reuses an index number. A
  // collision would silently substitute a different recording and turn a
  // dedupe assertion into a test of nothing.
  const id = `ptrack-${providerNamespace}-${provider}-g${group}-${index}`;
  return {
    id,
    provider,
    providerTrackId: id,
    title: `Shared Song ${group}`,
    artistId: `partist-${providerNamespace}-${group}`,
    artistName: `Shared Artist ${group}`,
    albumId: `palbum-${providerNamespace}-${group}`,
    albumName: `Shared Album ${group}`,
    duration: 180 + group,
    providerUrl: `https://${provider}.example/track/g${group}/${index}`,
  };
}

async function cleanup(namespace: string): Promise<void> {
  await prisma.track.deleteMany({
    where: {
      OR: [
        { provider: { startsWith: namespace } },
        // Cross-provider fixtures carry a real provider, so they can only be
        // found through the namespaced provider id.
        { providerTrackId: { startsWith: `ptrack-${namespace}-` } },
      ],
    },
  });
  await prisma.album.deleteMany({
    where: {
      OR: [
        { provider: { startsWith: namespace } },
        { providerAlbumId: { startsWith: `palbum-${namespace}-` } },
      ],
    },
  });
  await prisma.follow.deleteMany({
    where: { artist: { provider: { startsWith: namespace } } },
  });
  await prisma.artist.deleteMany({
    where: {
      OR: [
        { provider: { startsWith: namespace } },
        { providerArtistId: { startsWith: `partist-${namespace}-` } },
      ],
    },
  });
}

export const dbTest = {
  providerNamespace,
  createUser,
  makeArtist,
  makeTrack,
  makeProviderTrack,
  cleanup,
  prisma,
};