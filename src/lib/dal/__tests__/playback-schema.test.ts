import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Playback persistence schema gates (Phase 24). Temporary playback data
 * must never gain a database home: the PlaybackState model stays limited
 * to stable identity + position, and migrations stay an explicit,
 * reviewable set (a new migration fails this gate on purpose — update the
 * allowlist only while reviewing what it stores).
 */

const prismaDir = resolve(process.cwd(), "prisma");
const KNOWN_MIGRATIONS = [
  "20260920094042_postgresql_baseline",
  "20260921155846_add_playback_state",
  // Phase 40 (reviewed): one additive nullable JSON column carrying the
  // versioned queue snapshot (stable identity + display metadata only).
  // Rollback: drop the column; legacy provider/trackId/position columns
  // keep single-track restore working on the previous artifact.
  "20260925090000_add_queue_snapshot",
  // Phase 42 (reviewed): one additive nullable TEXT column for the
  // explicit account language preference (null = no preference).
  // Rollback: drop the column; locale falls back to cookie, then vi.
  "20260925100000_add_user_locale",
  // Phase 47 (reviewed): additive only, all with defaults that preserve
  // existing behaviour — `Playlist.visibility` defaults to "private", so
  // every existing row keeps owner-only access; `Playlist.shareToken` is
  // nullable, so a private playlist has no token to find; and
  // `User.keepListening` defaults to false, so the documented
  // stop-at-end-of-queue behaviour is unchanged until someone opts in.
  // No data backfill, no second artwork column, no playback-URL storage.
  // Rollback: drop `shareToken` + its unique index (revoking every shared
  // link), drop `visibility` (every playlist becomes owner-only), drop
  // `keepListening` (continuation reverts to opt-in per session).
  "20260926120000_add_playlist_sharing_and_keep_listening",
  // Phase 53 (reviewed): one additive nullable JSONB column carrying the
  // versioned appearance preference (glass mode, the eight glass/background
  // controls, the background selection). NULL = no preference, and the
  // resolution order is account → cookie → default, so a null row is
  // indistinguishable from "has not chosen".
  //
  // Reviewed specifically against the rule this file exists to enforce: a
  // preference, not playback data. It holds no track id, no provider, no
  // position and no queue, so it is not a new home for temporary playback
  // state, and the stored value is the compact encoding that OMITS every
  // field equal to the default — an untouched account writes ~12 bytes, and
  // a background is a single https URL string, never image bytes.
  //
  // Rollback: drop the column; appearance falls back to the cookie, then to
  // the shipped Aurora defaults. No other column depends on it.
  "20260926120001_add_user_appearance",
  // Phase 53 addendum (reviewed): one additive nullable JSON column carrying the
  // equalizer preference - enabled flag, preset id, ten band gains, headroom
  // mode. A COLUMN and not a table, because a preference belongs on the
  // account; a second table would be a second preference system, which
  // addendum §40 rules out explicitly.
  //
  // Like `appearance`, and for the same reasons, this is a preference and NOT
  // playback data: no track id, no provider, no position, no queue, no stream
  // URL. The stored value is the compact encoding that OMITS every field equal
  // to the default, so an untouched account writes `{"v":1}` and the whole
  // column costs nothing for the overwhelming majority of rows. Deliberately
  // NOT part of `PlaybackState` - an equalizer curve is a device preference and
  // a queue position is not, and §39 requires the two lifecycles to be
  // separable, which means "clear my playback session" must not clear the
  // equalizer.
  //
  // Rollback: drop the column; the equalizer falls back to the cookie, then to
  // the shipped Aurora V-Shape. No other column depends on it.
  //
  // SUPERSEDED (reviewed): the equalizer was removed from the product, so a
  // later migration drops this column. Kept in the allowlist because applied
  // migration history is immutable.
  "20260926120002_add_user_audio_eq",
  // Phase "remove equalizer" (reviewed): drops the now-unread `User.audioEq`
  // column added above. The feature was removed end to end, so the preference
  // has no reader and no writer; the column stored no playback data, so dropping
  // it cannot affect the session, the queue, providers or any other preference.
  //
  // Rollback: re-add `"User"."audioEq" JSONB` (nullable, no default). There is
  // nothing to restore the data to, because the feature it belonged to is gone.
  "20260930120000_drop_user_audio_eq",
  // Canonical duplicate prevention (reviewed): one unique index, preceded by
  // an EXACT cleanup that merges only identical `(userId, trackId)` rows and
  // keeps the newest of each. No column is added, dropped or retyped, and no
  // two distinct songs can be collapsed - the statement compares primary
  // identity only, never titles, artists or durations. Measured on the
  // development database before applying: 42 rows, 5 duplicate groups, 13
  // rows for the single most-played track. After: 12 rows, 0 duplicate groups.
  //
  // Rollback: drop the index. The duplicates do not come back, but nothing
  // else depends on the constraint - it prevents new ones.
  "20260926130000_recently_played_one_row_per_track",
  // Recency-ordering indexes (reviewed): two indexes, no data. `Like` and
  // `Follow` are both read `ORDER BY createdAt DESC` (the app shell's like
  // mirror on every authenticated render, and `listFollowedArtists` for the
  // library, radio signals and radio page), and neither's existing
  // `@@unique([userId, <child>])` nor `@@index([userId])` can serve that sort
  // - so Postgres sorted the user's entire history before applying `LIMIT`.
  // `@@index([userId, createdAt])` is the same shape `RecentlyPlayed` already
  // uses, and it supersedes `@@index([userId])` on both models rather than
  // duplicating it.
  //
  // Stores nothing, adds no column, rewrites no table, and changes no query:
  // the old artifact runs unchanged on the new schema (the planner just stops
  // sorting) and the new artifact runs unchanged on the old schema (it falls
  // back to today's sort). Backward compatible in both directions.
  //
  // Rollback: re-create `@@index([userId])` on both models and drop the two
  // `(userId, createdAt)` indexes - restoring the previous sort, not any state.
  "20261002120000_like_follow_recency_indexes",
];

function modelBlock(schema: string, model: string): string {
  const match = schema.match(new RegExp(`model ${model} \\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}

describe("playback persistence schema", () => {
  it("keeps temporary playback data out of PlaybackState", () => {
    const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
    const block = modelBlock(schema, "PlaybackState");
    expect(block.length).toBeGreaterThan(0);
    for (const forbidden of [
      "streamUrl",
      "previewUrl",
      "AudioSource",
      "googlevideo",
    ]) {
      expect(block, forbidden).not.toContain(forbidden);
    }
    expect(block).toContain("providerTrackId");
  });

  it("keeps migrations an explicitly reviewed set", () => {
    const entries = readdirSync(join(prismaDir, "migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(entries).toEqual([...KNOWN_MIGRATIONS].sort());
  });

  it("declares one Recently Played row per (user, track) at the database level", () => {
    const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
    const block = modelBlock(schema, "RecentlyPlayed");
    expect(block.length).toBeGreaterThan(0);
    // The constraint is the half of the rule SQL can enforce, and the half
    // that closes the concurrent-write window: two requests that both pass a
    // read-side existence check can still not both commit.
    expect(block).toContain("@@unique([userId, trackId])");
    // Recency ordering still needs its index; the unique constraint does not
    // provide it, because it leads with userId alone.
    expect(block).toContain("@@index([userId, playedAt])");
  });

  it("keeps playlist membership unique per (playlist, track) and per position", () => {
    const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
    const block = modelBlock(schema, "PlaylistTrack");
    expect(block).toContain("@@unique([playlistId, trackId])");
    expect(block).toContain("@@unique([playlistId, position])");
  });

  it("indexes every newest-first user collection on its sort column", () => {
    // `listUserLikes` and `listFollowedArtists` are both
    // `ORDER BY createdAt DESC` under a `take`, and both run on page render.
    // A `@@index([userId])` cannot serve that sort: Postgres reads every row
    // the user owns and sorts before `LIMIT` applies. These three models are
    // the whole user-owned recency surface, and all three must lead their
    // index with the sort column - `RecentlyPlayed` was already correct, and
    // `Like`/`Follow` were quietly paying an in-memory sort per render.
    const schema = readFileSync(join(prismaDir, "schema.prisma"), "utf8");
    for (const [model, column] of [
      ["RecentlyPlayed", "playedAt"],
      ["Like", "createdAt"],
      ["Follow", "createdAt"],
    ] as const) {
      const block = modelBlock(schema, model);
      expect(block.length, `model ${model} not found`).toBeGreaterThan(0);
      expect(block, `${model} lacks a recency index`).toContain(
        `@@index([userId, ${column}])`,
      );
    }
  });
});
