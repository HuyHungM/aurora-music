export type ProviderId = string;

/**
 * Closed production music-source set for the Music Engine.
 * Canonical definition lives here so both the existing TrackRef contract
 * and the new SourceReference contract share one source vocabulary.
 *
 * `local` is NOT a provider. It is a fourth source type for audio the user
 * already holds on their own disk, reached through the File System Access
 * API. It exists because `PlaybackResolver` is a registry keyed by source
 * type: a local file must be resolvable by the same orchestration that
 * resolves YouTube, and a separate player would mean a second playback
 * authority (RULE 4).
 *
 * The two properties that make `local` safe to carry here rather than
 * special-cased are enforced elsewhere and asserted by tests: a local
 * source is never resolved server-side, and never persisted (see
 * `lib/offline/` and ARCHITECTURE.md).
 */
export type SourceType = "youtube" | "spotify" | "deezer" | "local";

/**
 * The offline source type as a VALUE, for the code that needs to test it
 * (server-side isolation guards) without re-spelling the literal in three
 * places.
 */
export const LOCAL_SOURCE_TYPE = "local" as const satisfies SourceType;

export interface TrackRef {
  provider: string;
  providerTrackId: string;
}