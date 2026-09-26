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
  });

  /**
   * Phase 49 security regression. `Track` rows are a shared, unowned
   * catalog, and every production caller of `upsertTrack` is fed a Track
   * that arrived from a client payload. While the create/update branches
   * still wrote `streamUrl` / `previewUrl` / `metadata`, any authenticated
   * user could overwrite those fields on a row that every other user - and
   * every anonymous visitor of a shared playlist - then read back.
   *
   * The write path must therefore never persist them, on create or on
   * update. Playback does not need them: `PlaybackController` resolves a
   * fresh `AudioSource` per load and never reads these fields as playback
   * input (see `playback/controller.ts`).
   */
  it("never persists client-supplied media URLs or free-form metadata", async () => {
    const track = dbTest.makeTrack(namespace, 23);

    // A hostile payload rides along on the client Track shape.
    const hostile = {
      ...track,
      streamUrl: "https://attacker.example/probe.mp3",
      previewUrl: "https://attacker.example/probe.mp3",
      metadata: { injected: true },
    } as unknown as typeof track;

    const trackId = await upsertTrack(prisma, hostile);
    const created = await prisma.track.findUniqueOrThrow({ where: { id: trackId } });

    // Nothing from the payload reached the row.
    expect(created.streamUrl).toBeNull();
    expect(created.previewUrl).toBeNull();
    expect(created.metadata).toBeNull();
    // Display fields the catalog legitimately owns were still written, so
    // the fix is scoped to the untrusted fields and not a write regression.
    expect(created.title).toBe(track.title);
    expect(created.artworkUrl).toBe(track.artworkUrl);

    // Update must not clobber values already on the row either: seed a row
    // that already holds a legitimate provider value, then replay the
    // hostile payload against the same (provider, providerTrackId).
    const seeded = await prisma.track.update({
      where: { id: trackId },
      data: { streamUrl: "https://cdn.legit.example/track.mp3" },
    });
    expect(seeded.streamUrl).toBe("https://cdn.legit.example/track.mp3");

    const again = await upsertTrack(prisma, hostile);
    const afterUpdate = await prisma.track.findUniqueOrThrow({ where: { id: again } });
    expect(afterUpdate.streamUrl).toBe("https://cdn.legit.example/track.mp3");
    expect(afterUpdate.previewUrl).toBeNull();
    expect(afterUpdate.metadata).toBeNull();
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