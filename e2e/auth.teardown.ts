/**
 * Authenticated E2E teardown project (Phase 30). Runs after the
 * chromium project even on failure: deletes exactly the synthetic
 * rows, asserts zero leftovers (no orphans, no duplicates, no
 * dangling likes), and removes generated browser auth state so no
 * session token can be reused by a later run.
 */
import { test as teardown, expect } from "@playwright/test";
import { rmSync } from "node:fs";
import { AUTH_STATE_DIR } from "./auth/constants";
import { cleanupAuthState } from "./auth/run";

teardown("cleanup authenticated E2E state", () => {
  const remaining = cleanupAuthState();
  expect(remaining.users).toBe(0);
  expect(remaining.playlists).toBe(0);
  expect(remaining.playlistTracks).toBe(0);
  expect(remaining.likes).toBe(0);
  expect(remaining.fixtureTracks).toBe(0);
  expect(remaining.total).toBe(0);
  rmSync(AUTH_STATE_DIR, { recursive: true, force: true });
});
