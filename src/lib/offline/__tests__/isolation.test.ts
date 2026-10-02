import { describe, expect, it } from "vitest";
import { isOfflineSource, isOfflineTrack } from "@/lib/offline/isolation";
import { isSourceType, isProviderSourceType } from "@/lib/domain";
import { serializeQueueSnapshot } from "@/lib/player/queue-snapshot";
import type { Track } from "@/lib/domain";

/**
 * Offline isolation: a local track is never catalog data. These assertions are
 * the server-side half of that rule; the UI also hides the controls, but a
 * hand-written request does not read the UI.
 */

function localTrack(id = "Album/Song.mp3"): Track {
  return {
    id,
    provider: "local",
    providerTrackId: id,
    title: "Song",
    artistId: "local",
    artistName: "Album",
    duration: 213,
  };
}

describe("offline isolation predicate", () => {
  it("recognises only the local source", () => {
    expect(isOfflineSource("local")).toBe(true);
    expect(isOfflineSource("youtube")).toBe(false);
    expect(isOfflineSource("spotify")).toBe(false);
    expect(isOfflineSource(undefined)).toBe(false);
    expect(isOfflineSource("LOCAL")).toBe(false);
  });

  it("reads the provider off a track without trusting the payload", () => {
    expect(isOfflineTrack(localTrack())).toBe(true);
    expect(isOfflineTrack({ provider: "youtube" })).toBe(false);
    expect(isOfflineTrack(null)).toBe(false);
    expect(isOfflineTrack(undefined)).toBe(false);
  });

  it("keeps `local` a valid source but not a provider", () => {
    // A local file must canonicalize (it carries stable identity and has to
    // survive `toTrackIdentity`), while never being treated as a catalog
    // provider that a server route could be asked about.
    expect(isSourceType("local")).toBe(true);
    expect(isProviderSourceType("local")).toBe(false);
    expect(isProviderSourceType("youtube")).toBe(true);
    expect(isProviderSourceType("deezer")).toBe(true);
  });
});

describe("offline tracks are excluded from the persisted queue", () => {
  it("drops a local entry instead of saving an unplayable one", () => {
    // A restored `local` entry would name a file in a folder this profile may
    // never be granted again: a track that cannot play and cannot be repaired
    // by retrying. The slot vanishing from the saved queue is the honest
    // outcome.
    const snapshot = serializeQueueSnapshot({
      queue: [localTrack("a.mp3"), localTrack("b.mp3")],
      playOrder: [0, 1],
      position: 0,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off",
    });

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.playOrder).toEqual([]);
    expect(snapshot.position).toBe(-1);
  });

  it("keeps provider tracks and rebuilds indices around the dropped ones", () => {
    const youtube: Track = {
      id: "dQw4w9WgXcQ",
      provider: "youtube",
      providerTrackId: "dQw4w9WgXcQ",
      title: "Rick Astley",
      artistId: "UC1",
      artistName: "Rick Astley",
      duration: 212,
    };

    const snapshot = serializeQueueSnapshot({
      // Local first, so a naive index copy would point the provider track at
      // the wrong entry.
      queue: [localTrack("a.mp3"), youtube],
      playOrder: [1],
      position: 0,
      mediaPosition: 12,
      shuffle: false,
      repeat: "off",
    });

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.providerTrackId).toBe("dQw4w9WgXcQ");
    // The local track occupied index 0, so the provider track remaps to 0.
    expect(snapshot.playOrder).toEqual([0]);
    expect(snapshot.position).toBe(0);
    expect(snapshot.mediaPosition).toBe(12);
  });
});