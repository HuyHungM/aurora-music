/**
 * Live E2E fixture contract (Phase 17 §10). Plain data only:
 * provider + id + expected title fragment + playable flag.
 * No URLs, no expiry values, no secrets — ever.
 */
export const FIXTURE_A = {
  provider: "youtube",
  providerTrackId: "dQw4w9WgXcQ",
  titleFragment: "Never Gonna Give You Up",
  playable: true,
} as const;

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
