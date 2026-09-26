-- AlterTable: explicit account language preference (Phase 42).
-- Nullable column only: null means "no explicit preference" and falls
-- back to the anonymous cookie, then Vietnamese. No backfill, no default.
ALTER TABLE "User" ADD COLUMN "locale" TEXT;
