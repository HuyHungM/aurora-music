/**
 * Shared constants for the authenticated E2E harness (Phase 30).
 *
 * Pure data only: synthetic identities, the deterministic fixture
 * catalog, and helpers. No secrets, no tokens, no production
 * credentials — everything here is safe to read in any environment.
 */

/** Explicit test-only flag enabling the fixture library route. */
export const E2E_AUTH_FLAG = "AURORA_E2E_AUTH";

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
