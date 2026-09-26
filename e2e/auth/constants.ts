/**
 * Shared constants for the authenticated E2E harness (Phase 30).
 *
 * Pure data only: synthetic identities, the deterministic fixture
 * catalog, and helpers. No secrets, no tokens, no production
 * credentials — everything here is safe to read in any environment.
 */

/** Explicit test-only flag enabling the fixture library route. */
export const E2E_AUTH_FLAG = "AURORA_E2E_AUTH";

/**
 * Account language preference seeded for the synthetic E2E users.
 *
 * The application default is Vietnamese, but the authenticated specs
 * assert real user-visible accessible names that are authored in English
 * ("Play …", "Actions for …", "Player bar"). Locale precedence is
 * account preference → cookie → Vietnamese, so an explicit account
 * preference is the one deterministic way to pin the rendered language
 * without a cookie in the generated storage state.
 *
 * This is also the mechanism Phase 42 actually ships, so seeding it
 * exercises the authenticated-preference path rather than a test-only
 * backdoor. The vi/en locale logic itself is covered by unit tests on
 * `resolveLocale` / `isLocale` and key parity; nothing here changes
 * product behavior.
 */
export const E2E_LOCALE = "en";

/** Directory (repo-root-relative) for generated browser auth state. */
export const AUTH_STATE_DIR = "e2e/.auth";

export interface SyntheticUser {
  role: "a" | "b";
  email: string;
  name: string;
}

export const TEST_USERS: SyntheticUser[] = [
  { role: "a", email: "e2e-user-a@aurora.test", name: "Aurora E2E User A" },
  { role: "b", email: "e2e-user-b@aurora.test", name: "Aurora E2E User B" },
];

export const FIXTURE_ARTIST = {
  provider: "youtube",
  providerArtistId: "e2e-artist",
  name: "Aurora E2E Artist",
} as const;

export interface FixtureTrack {
  provider: string;
  providerTrackId: string;
  title: string;
}

export const FIXTURE_TRACKS: FixtureTrack[] = [
  {
    provider: "youtube",
    providerTrackId: "e2e-track-1",
    title: "Aurora E2E Track One",
  },
  {
    provider: "youtube",
    providerTrackId: "e2e-track-2",
    title: "Aurora E2E Track Two",
  },
];

/**
 * Two provider renderings of ONE recording, for canonical-duplicate journeys.
 *
 * Same title, same artist, no duration on either: that is a plain cross-provider
 * pair and lands in the matcher's `strong` band, which is the band a
 * deduplicating caller is allowed to act on unattended. Deliberately NOT added
 * to `FIXTURE_TRACKS`, for two reasons:
 *
 * 1. Their `providerTrackId`s sort after `e2e-track-*`, so the fixture library
 *    page (`orderBy providerTrackId`) appends them and no existing spec's
 *    positional row selector shifts.
 * 2. They share a visible title on purpose. A spec asserting "one track" must
 *    therefore scope by row rather than by text, and the ambiguity is the
 *    point: two rows the user can see must read as one song everywhere the
 *    product holds user collections.
 *
 * Neither is playable: playback needs a live provider, and these ids are
 * synthetic. That is fine — every journey here is a queue/membership/read
 * journey, and none of them requires audio.
 */
export const FIXTURE_CROSS_PROVIDER_TRACKS: FixtureTrack[] = [
  {
    provider: "spotify",
    providerTrackId: "e2e-xprov-spotify",
    title: "Aurora E2E Cross Provider",
  },
  {
    provider: "deezer",
    providerTrackId: "e2e-xprov-deezer",
    title: "Aurora E2E Cross Provider",
  },
];

/**
 * Test-only session lifetime (1h). Long enough for the suite, never
 * permanent. Production session configuration is untouched.
 */
export const SESSION_MAX_AGE_SECONDS = 3600;

/**
 * Derives the Auth.js session cookie name exactly the way Auth.js does:
 * `__Secure-` prefix only for HTTPS origins. The local/CI E2E server
 * runs plain HTTP, so the cookie is `authjs.session-token`; the name is
 * never assumed — setup verifies it against /api/auth/session.
 */
export function sessionCookieName(baseURL: string): string {
  return baseURL.startsWith("https://")
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
}

/** Repo-root-relative path of a generated storage-state file. */
export function storageStatePath(role: string): string {
  return `${AUTH_STATE_DIR}/${role}.json`;
}
