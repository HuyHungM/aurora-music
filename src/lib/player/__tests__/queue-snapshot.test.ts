import { describe, expect, it } from "vitest";
import type { Track } from "@/lib/domain";
import {
  MAX_PERSISTED_QUEUE_ENTRIES,
  QUEUE_SNAPSHOT_VERSION,
  queueSnapshotContentKey,
  serializeQueueSnapshot,
  snapshotToTracks,
  validateQueueSnapshot,
} from "@/lib/player/queue-snapshot";

function makeTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Track ${id}`,
    artistId: "a1",
    artistName: "Artist",
    ...overrides,
  };
}

describe("serializeQueueSnapshot", () => {
  it("round-trips order, playOrder, position, shuffle, and repeat", () => {
    const queue = [makeTrack("a"), makeTrack("b"), makeTrack("c")];
    const snapshot = serializeQueueSnapshot({
      queue,
      playOrder: [2, 0, 1],
      position: 1,
      mediaPosition: 42,
      shuffle: true,
      repeat: "all",
    });
    expect(snapshot.version).toBe(QUEUE_SNAPSHOT_VERSION);
    expect(snapshot.entries.map((e) => e.providerTrackId)).toEqual(["a", "b", "c"]);
    expect(snapshot.playOrder).toEqual([2, 0, 1]);
    expect(snapshot.position).toBe(1);
    expect(snapshot.mediaPosition).toBe(42);
    expect(snapshot.shuffle).toBe(true);
    expect(snapshot.repeat).toBe("all");
    expect(validateQueueSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("preserves repeated occurrences without deduplication", () => {
    const snapshot = serializeQueueSnapshot({
      queue: [makeTrack("a"), makeTrack("b"), makeTrack("a")],
      playOrder: [0, 1, 2],
      position: 2,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off",
    });
    expect(snapshot.entries).toHaveLength(3);
    expect(snapshotToTracks(snapshot).map((t) => t.providerTrackId)).toEqual([
      "a",
      "b",
      "a",
    ]);
  });

  it("serializes an empty queue as an empty (persistable) snapshot", () => {
    const snapshot = serializeQueueSnapshot({
      queue: [],
      playOrder: [],
      position: -1,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off",
    });
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.position).toBe(-1);
    expect(validateQueueSnapshot(snapshot)).toEqual(snapshot);
  });

  it("carries merged sources but never playback URLs", () => {
    const track = makeTrack("a", {
      streamUrl: "https://googlevideo.example/v",
      previewUrl: "https://cdn.example/p",
      metadata: {
        sources: [
          { source: "spotify", id: "sp1" },
          { source: "youtube", id: "a" },
          { source: "", id: "bad" },
        ],
      },
    });
    const snapshot = serializeQueueSnapshot({
      queue: [track],
      playOrder: [0],
      position: 0,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off",
    });
    expect(snapshot.entries[0].sources).toEqual([
      { source: "spotify", id: "sp1" },
      { source: "youtube", id: "a" },
    ]);
    const raw = JSON.stringify(snapshot);
    expect(raw).not.toContain("googlevideo");
    expect(raw).not.toContain("streamUrl");
    expect(raw).not.toContain("previewUrl");
    expect(raw).not.toContain("mimeType");
  });

  it("truncates oversized queues with repaired indices", () => {
    const queue = Array.from(
      { length: MAX_PERSISTED_QUEUE_ENTRIES + 10 },
      (_, i) => makeTrack(`t${i}`),
    );
    const snapshot = serializeQueueSnapshot({
      queue,
      playOrder: queue.map((_, i) => i),
      position: queue.length - 1,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off",
    });
    expect(snapshot.entries).toHaveLength(MAX_PERSISTED_QUEUE_ENTRIES);
    expect(validateQueueSnapshot(snapshot)).toEqual(snapshot);
  });
});

describe("validateQueueSnapshot", () => {
  const valid = () =>
    serializeQueueSnapshot({
      queue: [makeTrack("a")],
      playOrder: [0],
      position: 0,
      mediaPosition: 5,
      shuffle: false,
      repeat: "one",
    });

  it("rejects wrong versions, shapes, and out-of-range indices", () => {
    expect(validateQueueSnapshot(null)).toBeNull();
    expect(validateQueueSnapshot({ ...valid(), version: 999 })).toBeNull();
    expect(validateQueueSnapshot({ ...valid(), playOrder: [7] })).toBeNull();
    expect(validateQueueSnapshot({ ...valid(), position: 5 })).toBeNull();
    expect(validateQueueSnapshot({ ...valid(), repeat: "track" })).toBeNull();
    expect(validateQueueSnapshot({ ...valid(), shuffle: "yes" })).toBeNull();
    expect(validateQueueSnapshot({ ...valid(), mediaPosition: -1 })).toBeNull();
    expect(validateQueueSnapshot({ ...valid(), entries: [{ nope: true }] })).toBeNull();
  });

  it("rejects entries carrying playback-URL-shaped fields", () => {
    const snapshot = valid();
    const poisoned = {
      ...snapshot,
      entries: [{ ...snapshot.entries[0], streamUrl: "https://x.example/a" }],
    };
    expect(validateQueueSnapshot(poisoned)).toBeNull();
  });

  it("rejects empty queues with a non-negative cursor", () => {
    const snapshot = valid();
    expect(
      validateQueueSnapshot({ ...snapshot, entries: [], playOrder: [], position: 0 }),
    ).toBeNull();
  });
});

describe("Phase 43 player preferences and version migration", () => {
  it("round-trips volume, mute, and the write timestamp", () => {
    const snapshot = serializeQueueSnapshot({
      queue: [makeTrack("a")],
      playOrder: [0],
      position: 0,
      mediaPosition: 12,
      shuffle: false,
      repeat: "off",
      volume: 0.75,
      muted: true,
      savedAt: 1_700_000_000_000,
    });
    expect(snapshot.volume).toBe(0.75);
    expect(snapshot.muted).toBe(true);
    expect(snapshot.savedAt).toBe(1_700_000_000_000);
    expect(validateQueueSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("defaults missing preferences to full volume and unmuted", () => {
    const snapshot = serializeQueueSnapshot({
      queue: [makeTrack("a")],
      playOrder: [0],
      position: 0,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off",
    });
    expect(snapshot.volume).toBe(1);
    expect(snapshot.muted).toBe(false);
    expect(snapshot.savedAt).toBeGreaterThan(0);
  });

  it("clamps an out-of-range volume instead of persisting it", () => {
    const base = {
      queue: [makeTrack("a")],
      playOrder: [0],
      position: 0,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off" as const,
    };
    expect(serializeQueueSnapshot({ ...base, volume: 4 }).volume).toBe(1);
    expect(serializeQueueSnapshot({ ...base, volume: -2 }).volume).toBe(0);
    expect(serializeQueueSnapshot({ ...base, volume: Number.NaN }).volume).toBe(1);
  });

  it("migrates a v1 session instead of discarding the user's queue", () => {
    const v1 = {
      version: 1,
      entries: [
        {
          provider: "youtube",
          providerTrackId: "a",
          title: "Track A",
          artistId: "a1",
          artistName: "Artist",
        },
      ],
      playOrder: [0],
      position: 0,
      mediaPosition: 34,
      shuffle: true,
      repeat: "all",
    };
    const migrated = validateQueueSnapshot(v1);
    expect(migrated).not.toBeNull();
    expect(migrated?.version).toBe(QUEUE_SNAPSHOT_VERSION);
    // Everything the v1 row knew is preserved verbatim...
    expect(migrated?.entries.map((e) => e.providerTrackId)).toEqual(["a"]);
    expect(migrated?.playOrder).toEqual([0]);
    expect(migrated?.position).toBe(0);
    expect(migrated?.mediaPosition).toBe(34);
    expect(migrated?.shuffle).toBe(true);
    expect(migrated?.repeat).toBe("all");
    // ...and only the new fields take their documented defaults.
    expect(migrated?.volume).toBe(1);
    expect(migrated?.muted).toBe(false);
    expect(migrated?.savedAt).toBe(0);
  });

  it("rejects a future version rather than guessing at its shape", () => {
    const v1 = {
      version: 1,
      entries: [
        {
          provider: "youtube",
          providerTrackId: "a",
          title: "Track A",
          artistId: "a1",
          artistName: "Artist",
        },
      ],
      playOrder: [0],
      position: 0,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off",
    };
    expect(validateQueueSnapshot({ ...v1, version: 0 })).toBeNull();
    expect(validateQueueSnapshot({ ...v1, version: QUEUE_SNAPSHOT_VERSION + 1 })).toBeNull();
    expect(validateQueueSnapshot({ ...v1, version: 1.5 })).toBeNull();
  });

  it("rejects current-version payloads with malformed preferences", () => {
    const snapshot = serializeQueueSnapshot({
      queue: [makeTrack("a")],
      playOrder: [0],
      position: 0,
      mediaPosition: 0,
      shuffle: false,
      repeat: "off",
    });
    expect(validateQueueSnapshot({ ...snapshot, volume: 1.5 })).toBeNull();
    expect(validateQueueSnapshot({ ...snapshot, volume: -0.1 })).toBeNull();
    expect(validateQueueSnapshot({ ...snapshot, volume: "loud" })).toBeNull();
    expect(validateQueueSnapshot({ ...snapshot, muted: "yes" })).toBeNull();
    expect(validateQueueSnapshot({ ...snapshot, savedAt: -1 })).toBeNull();
    expect(validateQueueSnapshot({ ...snapshot, savedAt: Number.NaN })).toBeNull();
  });

  it("keys write-deduplication on content, not the write timestamp", () => {
    const base = {
      queue: [makeTrack("a")],
      playOrder: [0],
      position: 0,
      mediaPosition: 8,
      shuffle: false,
      repeat: "off" as const,
      volume: 0.5,
    };
    const first = serializeQueueSnapshot({ ...base, savedAt: 1 });
    const second = serializeQueueSnapshot({ ...base, savedAt: 2 });
    // A heartbeat that re-serializes an unchanged session must not
    // produce a different key, or every tick would issue a request.
    expect(queueSnapshotContentKey(first)).toBe(queueSnapshotContentKey(second));

    // A real change must produce a different key.
    const seeked = serializeQueueSnapshot({ ...base, mediaPosition: 9, savedAt: 3 });
    expect(queueSnapshotContentKey(seeked)).not.toBe(queueSnapshotContentKey(first));
    const muted = serializeQueueSnapshot({ ...base, muted: true, savedAt: 4 });
    expect(queueSnapshotContentKey(muted)).not.toBe(queueSnapshotContentKey(first));
    const quieter = serializeQueueSnapshot({ ...base, volume: 0.2, savedAt: 5 });
    expect(queueSnapshotContentKey(quieter)).not.toBe(queueSnapshotContentKey(first));
  });

  it("never serializes playback URLs, credentials, or session cookies", () => {
    const snapshot = serializeQueueSnapshot({
      queue: [
        makeTrack("a", {
          streamUrl: "https://r1---sn-x.googlevideo.com/videoplayback?expire=1",
          previewUrl: "https://cdn.example/preview.mp3",
          accessToken: "ya29.super-secret",
          sessionCookie: "authjs.session-token=abc",
        } as Partial<Track>),
      ],
      playOrder: [0],
      position: 0,
      mediaPosition: 3,
      shuffle: false,
      repeat: "off",
      volume: 0.5,
      muted: false,
    });
    const raw = JSON.stringify(snapshot);
    for (const forbidden of [
      "googlevideo",
      "videoplayback",
      "streamUrl",
      "previewUrl",
      "accessToken",
      "sessionCookie",
      "authjs",
      "mimeType",
      "expiresAt",
      "bitrate",
    ]) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
    // Identity survives so the session can still be restored.
    expect(raw).toContain("a");
  });
});
