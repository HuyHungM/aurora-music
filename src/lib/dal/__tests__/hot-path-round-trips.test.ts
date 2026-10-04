/**
 * Round-trip regression guards for the hot write paths.
 *
 * Every DAL function takes its Prisma client as a parameter, so the exact
 * sequence of statements is observable through a recording stub — WITHOUT a
 * database. That matters here specifically: `bun run test:db` cannot run in this
 * environment (no valid Postgres TLS material), so a change to the data layer
 * would otherwise ship with no executed coverage at all.
 *
 * These are not timing assertions. Each one counts statements or asserts that
 * two statements were IN FLIGHT simultaneously, which is deterministic.
 *
 * The changes pinned here, and why each is safe:
 *
 *   unlikeTrack / unfollowArtist / isFollowing
 *     Put the relation predicate in the `where` instead of resolving the
 *     provider ref to an internal id first. `isTrackLiked` already had this
 *     shape. `unlikeTrack`/`unfollowArtist` return `void`, so the removed
 *     "unknown ref → early return" branch was unobservable.
 *
 *   addSearch
 *     Dropped a `count()`. `skip: LIMIT` with no `take` already returns exactly
 *     the excess rows, so `oldest.length > 0` is the same predicate — the shape
 *     `recently-played.ts` adopted for its own trim.
 *
 *   recordPlayed
 *     The catalog upsert and the duplicate scan are independent (the scan needs
 *     only `track`), so they now run concurrently instead of in series.
 */
import { describe, expect, it } from "vitest";
import { unlikeTrack } from "@/lib/dal/like";
import { isFollowing, unfollowArtist } from "@/lib/dal/follow";
import { addSearch } from "@/lib/dal/search-history";
import { recordPlayed } from "@/lib/dal/recently-played";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Track } from "@/lib/domain";

interface Call {
  model: string;
  op: string;
}

/** Records every statement and can assert on overlap. */
function recorder() {
  const calls: Call[] = [];
  let open = 0;
  let maxConcurrent = 0;
  const record =
    (model: string, op: string) =>
    async (args?: unknown): Promise<unknown> => {
      calls.push({ model, op });
      open += 1;
      maxConcurrent = Math.max(maxConcurrent, open);
      try {
        // Yield so a serialized `await` chain cannot overlap by accident.
        await Promise.resolve();
        open -= 1;
        return reply(model, op, args);
      } catch (error) {
        open -= 1;
        throw error;
      }
    };

  const db = {
    artist: { upsert: record("artist", "upsert") },
    album: { upsert: record("album", "upsert") },
    track: { upsert: record("track", "upsert") },
    like: { deleteMany: record("like", "deleteMany"), findFirst: record("like", "findFirst") },
    follow: { deleteMany: record("follow", "deleteMany"), findFirst: record("follow", "findFirst") },
    searchHistory: {
      create: record("searchHistory", "create"),
      findMany: record("searchHistory", "findMany"),
      deleteMany: record("searchHistory", "deleteMany"),
      count: record("searchHistory", "count"),
    },
    recentlyPlayed: {
      findMany: record("recentlyPlayed", "findMany"),
      upsert: record("recentlyPlayed", "upsert"),
      deleteMany: record("recentlyPlayed", "deleteMany"),
    },
  };

  return {
    db: db as unknown as PrismaClient,
    calls,
    get maxConcurrent() {
      return maxConcurrent;
    },
    reset() {
      calls.length = 0;
      maxConcurrent = 0;
      open = 0;
    },
  };
}

function reply(model: string, op: string, args: unknown): unknown {
  if (op === "findFirst") return null;
  if (op === "upsert" && model === "artist") return { id: "artist-1" };
  if (op === "upsert" && model === "track") return { id: "track-1" };
  if (op === "upsert") return { id: "row-1" };
  if (op === "findMany") return [];
  if (op === "create") return { id: "row-1" };
  if (op === "deleteMany") return { count: 0 };
  void args;
  return null;
}

const TRACK: Track = {
  id: "t1",
  provider: "youtube",
  providerTrackId: "t1",
  title: "Never Gonna Give You Up",
  artistId: "a1",
  artistName: "Rick Astley",
};

const REF = { provider: "youtube", providerTrackId: "t1" } as const;
const ARTIST_REF = { provider: "youtube", providerArtistId: "a1" } as const;

describe("round trips: unlike / unfollow / isFollowing", () => {
  it("unlikeTrack issues ONE statement, with the relation predicate inline", async () => {
    const rec = recorder();
    await unlikeTrack("user-1", REF, rec.db);

    // Exactly one statement, and no `track.findUnique` in front of it — the
    // ref is now resolved by the delete's own relation predicate.
    expect(rec.calls).toEqual([{ model: "like", op: "deleteMany" }]);
    expect(rec.calls.some((call) => call.model === "track")).toBe(false);
  });

  it("unfollowArtist issues ONE statement", async () => {
    const rec = recorder();
    await unfollowArtist("user-1", ARTIST_REF, rec.db);

    expect(rec.calls).toEqual([{ model: "follow", op: "deleteMany" }]);
  });

  it("isFollowing issues ONE statement and answers false for an unknown artist", async () => {
    const rec = recorder();
    // The stub returns null for `findFirst`, i.e. "not following".
    await expect(isFollowing("user-1", ARTIST_REF, rec.db)).resolves.toBe(false);

    expect(rec.calls).toEqual([{ model: "follow", op: "findFirst" }]);
    // No `artist.findUnique` in front of it any more.
    expect(rec.calls.some((call) => call.model === "artist")).toBe(false);
  });
});

describe("round trips: addSearch", () => {
  it("never issues a count()", async () => {
    const rec = recorder();
    await addSearch("user-1", "  taylor swift  ", rec.db);

    expect(rec.calls.some((call) => call.op === "count")).toBe(false);
    expect(rec.calls.map((call) => call.op)).toEqual(["create", "findMany"]);
  });

  it("issues no delete when the history is within the limit", async () => {
    // The stub's `findMany` returns [], which is exactly what
    // `skip: HISTORY_LIMIT` with no `take` yields at or under the limit — so
    // the third statement must not run.
    const rec = recorder();
    await addSearch("user-1", "taylor swift", rec.db);

    expect(rec.calls).toHaveLength(2);
    expect(rec.calls.some((call) => call.op === "deleteMany")).toBe(false);
  });
});

describe("round trips: recordPlayed", () => {
  it("runs the catalog upsert and the duplicate scan CONCURRENTLY", async () => {
    const rec = recorder();
    await recordPlayed("user-1", TRACK, rec.db, new Date(0));

    // Both must be in flight at the same time. A serialized `await` chain caps
    // this at 1, which is exactly the regression this pins.
    expect(rec.maxConcurrent).toBeGreaterThanOrEqual(2);

    // The write that needs both results still happens, and still happens last.
    const ops = rec.calls.map((call) => `${call.model}.${call.op}`);
    expect(ops).toContain("recentlyPlayed.upsert");
    expect(ops).toContain("track.upsert");
    expect(ops.indexOf("recentlyPlayed.upsert")).toBeGreaterThan(
      ops.indexOf("recentlyPlayed.findMany"),
    );
  });

  it("still writes exactly one recently-played row", async () => {
    const rec = recorder();
    await recordPlayed("user-1", TRACK, rec.db, new Date(0));

    const writes = rec.calls.filter(
      (call) => call.model === "recentlyPlayed" && call.op === "upsert",
    );
    expect(writes).toHaveLength(1);
  });
});