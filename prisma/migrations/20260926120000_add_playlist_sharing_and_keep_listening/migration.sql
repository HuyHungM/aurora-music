-- Phase 47: playlist identity (sharing) + generic queue continuation.
--
-- Additive only, and deliberately conservative:
--   * `Playlist.artwork` already exists and is REUSED for custom artwork
--     (no second artwork column, no backfill, no file storage).
--   * `visibility` defaults to "private", so every existing row keeps its
--     current owner-only behaviour with no data migration.
--   * `shareToken` is nullable: private playlists have no token at all, so
--     sharing is a deliberate owner action rather than a default posture.
--   * `keepListening` defaults to false, preserving the documented
--     end-of-queue stop behaviour until a listener opts in.
--
-- `shareToken` carries no primary key, owner id, or provider id; it is
-- minted with 192 bits of cryptographic randomness (base64url) by
-- `mintShareToken()` and is the only identifier accepted by the public
-- share route.
ALTER TABLE "Playlist" ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "Playlist" ADD COLUMN "shareToken" TEXT;
ALTER TABLE "User" ADD COLUMN "keepListening" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Playlist_shareToken_key" ON "Playlist"("shareToken");
CREATE INDEX "Playlist_visibility_idx" ON "Playlist"("visibility");
