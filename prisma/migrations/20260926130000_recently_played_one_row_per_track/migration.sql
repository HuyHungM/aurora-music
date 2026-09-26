-- One Recently Played row per (user, track).
--
-- Measured on the development database before this migration: 42 rows for 2
-- users, of which 5 (userId, trackId) groups held more than one row - the
-- same recording appearing 13, 8 and 6 times. `recordPlayed` always INSERTed,
-- so the recency list was an append-only play log masquerading as a "recent"
-- list, and it is read as a recency signal (radio seeds, recommendation
-- signals) and shown as a list, both of which need one current entry per
-- track.
--
-- THE CLEANUP IS EXACT, NOT FUZZY. It merges only rows that are the SAME
-- `(userId, trackId)`, i.e. the same provider and the same provider track id,
-- which is a primary-key identity rather than a similarity judgement. Nothing
-- here compares titles, artists or durations, so no two genuinely different
-- songs can ever be collapsed by this statement.
--
-- THE KEPT ROW IS DETERMINISTIC. For each group the row with the greatest
-- `playedAt` wins, because recency is the only thing this table stores and
-- the newest occurrence is the correct current state. `id DESC` breaks ties
-- so repeated runs of the migration converge on the same survivor instead of
-- depending on physical row order.
--
-- `addedAt`-style metadata does not exist on this model and `id` is preserved
-- on the survivor, so nothing that identifies the row is rewritten.
--
-- Cross-provider duplicates (one recording present as two different `Track`
-- rows) are deliberately NOT merged here. Doing that in SQL would mean
-- comparing titles and durations inside the database, which is precisely the
-- fuzzy deletion this migration refuses to perform. Those are collapsed in
-- the DAL, which can run the canonical matcher with its calibrated thresholds.
DELETE FROM "RecentlyPlayed"
WHERE "id" NOT IN (
  SELECT DISTINCT ON ("userId", "trackId") "id"
  FROM "RecentlyPlayed"
  ORDER BY "userId", "trackId", "playedAt" DESC, "id" DESC
);

CREATE UNIQUE INDEX "RecentlyPlayed_userId_trackId_key"
  ON "RecentlyPlayed"("userId", "trackId");
