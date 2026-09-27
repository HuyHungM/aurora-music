import { FIXTURE_A, FIXTURE_B } from "@/lib/e2e/fixture-ids";

/**
 * Live E2E fixture contract (Phase 17 §10). Plain data only:
 * provider + id + expected title fragment + playable flag.
 * No URLs, no expiry values, no secrets — ever.
 *
 * The ids live in `src/lib/e2e/fixture-ids.ts` because the fixture ROUTE also
 * needs them: the secondary queue entry has to be a genuinely different
 * recording, and two copies of the same id is exactly what the product's
 * canonical dedupe (correctly) refuses to queue twice.
 */
export { FIXTURE_A, FIXTURE_B };

export const INVALID_ID = "aaaaaaaaaaa";

export function fixtureUrl(videoId: string): string {
  return `/e2e-playback/${videoId}`;
}

/** Redacts temporary media URLs before anything reaches logs/artifacts. */
export function redactSecrets(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"'`]*googlevideo[^\s"'`]*/gi, "[redacted-media-url]")
    .replace(/&sig=[^&\s"'`]*/gi, "&sig=[redacted]")
    .replace(/&lsig=[^&\s"'`]*/gi, "&lsig=[redacted]");
}
