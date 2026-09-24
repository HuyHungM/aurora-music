/**
 * Client-safe playback source backed by the server resolve action.
 *
 * youtubei.js never enters the browser: resolution runs server-side and
 * only the minimal serialized AudioSource crosses the boundary. Serialized
 * failures are revived into staged `PlaybackResolutionError`s (all Phase 08
 * resolver failures already have that shape), preserving stage and
 * retryability without leaking URLs, sessions, or internals.
 */

import type {
  AudioSource,
  SerializedAudioSource,
  SerializedEngineError,
  SourceReference,
} from "@/lib/domain";
import { PlaybackResolutionError, parseAudioSource } from "@/lib/domain";
import type { PlaybackResolutionStage } from "@/lib/domain";
import type { SourcePlaybackResolver } from "./resolver";

export type ResolveSourceAction = (
  provider: string,
  providerTrackId: string,
) => Promise<
  | { ok: true; source: SerializedAudioSource }
  | { ok: false; error: SerializedEngineError }
>;

const STAGES: readonly PlaybackResolutionStage[] = ["match", "resolve", "stream"];

function stageOf(error: SerializedEngineError): PlaybackResolutionStage {
  const stage = error.details?.stage;
  if (typeof stage === "string" && (STAGES as readonly string[]).includes(stage)) {
    return stage as PlaybackResolutionStage;
  }
  return "resolve";
}

export function createServerSourceResolver(
  action: ResolveSourceAction,
): SourcePlaybackResolver {
  return {
    source: "youtube",
    async resolveSource(ref: SourceReference): Promise<AudioSource> {
      const trackRef = { provider: ref.source, providerTrackId: ref.id };
      const result = await action(ref.source, ref.id);
      if (!result.ok) {
        throw new PlaybackResolutionError(trackRef, stageOf(result.error), result.error.message, {
          retryable: result.error.retryable,
        });
      }
      const source = parseAudioSource(result.source);
      if (!source) {
        throw new PlaybackResolutionError(trackRef, "stream", "Invalid playback source");
      }
      return source;
    },
  };
}
