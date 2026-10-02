-- Recency-ordering indexes for the two user-owned collections that are read
-- newest-first: `Like` and `Follow`.
--
-- Both models carry `@@unique([userId, trackId])` / `@@unique([userId,
-- artistId])` and `@@index([userId])`. Neither of those can serve an
-- `ORDER BY "createdAt" DESC`: the unique indexes lead with the child id and
-- the plain index leads with `userId` alone, so Postgres has to read every
-- row the user owns and sort them before applying `LIMIT`. `RecentlyPlayed`
-- already avoids this with `@@index([userId, playedAt])`; these two models
-- were simply missed.
--
-- What reads them:
--   - `listUserLikes`    - `ORDER BY createdAt DESC` on every authenticated
--                          page render (the app shell seeds the client like
--                          mirror with `take: 1000`).
--   - `listFollowedArtists` - `ORDER BY createdAt DESC` for the library page
--                          (`take: 50`), radio signals (`take: 5`) and the
--                          radio page (`take: 6`).
--
-- One index serves both sort directions: Postgres scans a B-tree backwards
-- for `DESC`. The indexes therefore supersede `@@index([userId])` on both
-- models rather than sitting beside it — a `(userId, createdAt)` index answers
-- every `WHERE userId = ?` predicate the plain one did, so keeping both would
-- be pure write amplification on tables that are written on every like and
-- every follow.
--
-- This migration stores no data, adds no column, and changes no query. Old
-- code runs unchanged on the new schema (the planner simply stops sorting),
-- and new code runs unchanged on the old schema (it falls back to the sort it
-- does today). No backfill, no table rewrite: `CREATE INDEX` (not
-- `CONCURRENTLY`) takes a brief write lock, so this is scheduled like any other
-- migration rather than run against a live write-heavy table.
--
-- Rollback: re-create `@@index([userId])` on `Like` and `Follow` and drop the
-- two `(userId, createdAt)` indexes. That restores the previous sort, not any
-- data - nothing here holds state.
CREATE INDEX "Like_userId_createdAt_idx" ON "Like"("userId", "createdAt");

CREATE INDEX "Follow_userId_createdAt_idx" ON "Follow"("userId", "createdAt");

DROP INDEX "Like_userId_idx";

DROP INDEX "Follow_userId_idx";