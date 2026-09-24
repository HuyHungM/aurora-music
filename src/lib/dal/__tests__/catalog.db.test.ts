import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Album } from "@/lib/domain";
import {
  findArtistInternalId,
  findTrackInternalId,
  upsertAlbum,
  upsertArtist,
  upsertTrack,
} from "@/lib/dal/catalog";
import { prisma } from "@/lib/db";
import { dbTest } from "./harness";

const namespace = dbTest.providerNamespace();

beforeAll(() => {
  // nothing to seed
});

afterAll(async () => {
  await dbTest.cleanup(namespace);
});

describe("catalog upsertArtist", () => {
  it("creates an artist and resolves its internal id", async () => {
    const id = await upsertArtist(prisma, dbTest.makeArtist(namespace, 1));
    expect(id).toBeTruthy();
    const found = await findArtistInternalId(prisma, {
      provider: namespace,
      providerArtistId: "artist-1",
    });
    expect(found).toBe(id);
  });

  it("is idempotent", async () => {
    const first = await upsertArtist(prisma, dbTest.makeArtist(namespace, 2));
    const second = await upsertArtist(prisma, dbTest.makeArtist(namespace, 2));
    expect(second).toBe(first);
    await expect(
      prisma.artist.count({ where: { provider: namespace } }),
    ).resolves.toBe(2);
  });

  it("refreshes the display name on update", async () => {
    const artist = dbTest.makeArtist(namespace, 3);
    await upsertArtist(prisma, artist);
    await upsertArtist(prisma, { ...artist, name: "Renamed Artist 3" });
    const row = await prisma.artist.findUniqueOrThrow({
      where: { provider_providerArtistId: { provider: namespace, providerArtistId: "artist-3" } },
    });
    expect(row.name).toBe("Renamed Artist 3");
  });
});

describe("catalog upsertAlbum", () => {
  it("creates an album with a resolved artist reference", async () => {
    const track = dbTest.makeTrack(namespace, 10);
    const albumId = await upsertAlbum(prisma, {
      id: track.albumId!,
      provider: namespace as Album["provider"],
      title: track.albumName!,
      artistId: track.artistId,
      artistName: track.artistName,
    });
    expect(albumId).toBeTruthy();
    const album = await prisma.album.findUniqueOrThrow({
      where: { id: albumId },
      include: { artist: true },
    });
    expect(album.name).toBe(track.albumName);
    expect(album.artist.name).toBe(track.artistName);
  });

  it("is idempotent", async () => {
    const track = dbTest.makeTrack(namespace, 11);
    const input = {
      id: track.albumId!,
      provider: namespace as Album["provider"],
      title: track.albumName!,
      artistId: track.artistId,
      artistName: track.artistName,
    };
    const first = await upsertAlbum(prisma, input);
    const second = await upsertAlbum(prisma, input);
    expect(second).toBe(first);
  });
});

describe("catalog upsertTrack", () => {
  it("creates a track with resolved artist and album", async () => {
    const track = dbTest.makeTrack(namespace, 20);
    const trackId = await upsertTrack(prisma, track);
    const row = await prisma.track.findUniqueOrThrow({
      where: { id: trackId },
      include: { artist: true, album: true },
    });
    expect(row.title).toBe(track.title);
    expect(row.artist.providerArtistId).toBe(track.artistId);
    expect(row.album?.providerAlbumId).toBe(track.albumId);
    expect(row.genres).toEqual(["jazz", "blues"]);
    expect(row.metadata).toEqual({ popularity: 20 });
  });

  it("resolves internal ids via lookup helpers", async () => {
    const track = dbTest.makeTrack(namespace, 21);
    await upsertTrack(prisma, track);
    await expect(
      findTrackInternalId(prisma, { provider: namespace, providerTrackId: track.id }),
    ).resolves.toBeTruthy();
    await expect(
      findTrackInternalId(prisma, { provider: namespace, providerTrackId: "nope" }),
    ).resolves.toBeNull();
  });

  it("is idempotent across runs", async () => {
    const track = dbTest.makeTrack(namespace, 22);
    const first = await upsertTrack(prisma, track);
    const second = await upsertTrack(prisma, { ...track, title: "Retitled" });
    expect(second).toBe(first);
    const row = await prisma.track.findUniqueOrThrow({ where: { id: first } });
    expect(row.title).toBe("Retitled");
  });
});