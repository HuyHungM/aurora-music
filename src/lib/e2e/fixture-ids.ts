/**
 * E2E fixture identity, shared by the fixture ROUTE (server component under
 * `src/`) and the specs (under `e2e/`).
 *
 * Why this file exists: the secondary fixture track used to be built by
 * re-using the primary's `providerTrackId` under a different title. That is the
 * same song as far as the product is concerned -
 * `dedupeCanonicalTracks` keys on `provider:providerTrackId`
 * (`lib/domain/track-dedupe.ts`) - so the queue collapsed it and every "2
 * tracks" assertion in the live suite became unreachable. Three tests failed
 * on every opt-in run as a result.
 *
 * Both ids are real, long-lived YouTube videos so the secondary resolves and
 * plays through the real resolver. They are data, not URLs, and carry no
 * secret; nothing here is exposed outside a fixture route that is itself
 * gated behind `AURORA_E2E_LIVE_PLAYBACK=1`.
 */
export const FIXTURE_A = {
  provider: "youtube",
  providerTrackId: "dQw4w9WgXcQ",
  titleFragment: "Never Gonna Give You Up",
  playable: true,
} as const;

/**
 * A DIFFERENT recording, so the queue genuinely holds two songs.
 *
 * Chosen because it is one of the most widely available videos on the
 * platform: the live suite is opt-in and network-dependent, so the second
 * fixture should be the least likely thing to become unresolvable. It is the
 * same artist and era as `FIXTURE_A`, which keeps the two songs
 * distinguishable by TITLE as well as by id - important, because a matcher
 * that collapsed them would then be collapsing the wrong thing.
 */
export const FIXTURE_B = {
  provider: "youtube",
  providerTrackId: "kJQP7kiw5Fk",
  title: "E2E Fixture B",
  artistName: "E2E fixture",
  playable: true,
} as const;
