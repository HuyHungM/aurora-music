-- AlterTable: versioned queue snapshot for authenticated playback
-- persistence (Phase 40). Additive nullable JSON column only: stable
-- track identity + display metadata, never playback URLs. Existing rows
-- read back as legacy single-track state; nothing is backfilled.
ALTER TABLE "PlaybackState" ADD COLUMN "queueSnapshot" JSONB;
