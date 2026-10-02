/**
 * Client-side `SourcePlaybackResolver` for local files. CLIENT-ONLY.
 *
 * It satisfies the SAME contract as the YouTube resolver (`lib/playback/
 * resolver.ts`), which is the whole reason a local file needed no new
 * playback pipeline: `PlaybackResolver` is a registry keyed by source type,
 * so registering this alongside the server resolver is enough for the existing
 * controller, ranking, transport controls, recovery and Media Session to work
 * on a local file unchanged.
 *
 * IT NEVER CALLS THE SERVER. There is no resolve action, no DAL write, no
 * provider lookup. The only thing crossing a boundary is a `File` the user
 * picked, which is read by the browser directly and streamed to the audio
 * element as an object URL.
 */

import type { AudioSource, SourceReference } from "@/lib/domain";
import { PlaybackResolutionError } from "@/lib/domain";
import type { SourcePlaybackResolver } from "@/lib/playback/resolver";
import { createObjectUrlFor, getFileRegistry } from "./session";
import { readRegisteredFile } from "./scan";
import { audioExtensionOf } from "./tracks";

/**
 * Extensions whose bytes can be handed to `<audio>` verbatim.
 *
 * Others are given an explicit type. Chrome refuses a blob URL with no type
 * for some containers, so this is a correctness detail rather than polish: a
 * `.m4b` or extensionless stream that "silently" fails to load is the exact
 * class of bug the resolver exists to explain.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  aiff: "audio/aiff",
  aif: "audio/aiff",
};

function mimeTypeFor(name: string, file: File): string | undefined {
  const extension = audioExtensionOf(name);
  const mapped = MIME_BY_EXTENSION[extension];
  if (mapped !== undefined) {
    return mapped;
  }
  // `File.type` is empty for uncommon containers on most platforms, so it is
  // a fallback rather than the primary source.
  return typeof file.type === "string" && file.type.length > 0 ? file.type : undefined;
}

function unavailable(ref: SourceReference, message: string): PlaybackResolutionError {
  return new PlaybackResolutionError(
    { provider: ref.source, providerTrackId: ref.id },
    "resolve",
    message,
    // Deliberately NOT retryable. Every recovery path here ends in "ask the
    // user to re-open /offline and scan again", which needs a user gesture the
    // bounded recovery cycle cannot perform. Marking it retryable would spend
    // the whole recovery budget re-discovering the same missing file.
    { retryable: false },
  );
}

export function createLocalSourceResolver(): SourcePlaybackResolver {
  return {
    source: "local",

    async resolveSource(ref: SourceReference): Promise<AudioSource> {
      const registry = getFileRegistry();
      if (registry.size === 0) {
        throw unavailable(ref, "Local files are not loaded. Open Local files and choose a folder.");
      }
      const file = await readRegisteredFile(registry, ref.id);
      if (!file) {
        throw unavailable(ref, "This local file is no longer available.");
      }

      const source: AudioSource = { url: createObjectUrlFor(file) };
      const mimeType = mimeTypeFor(file.name, file);
      if (mimeType !== undefined) {
        source.mimeType = mimeType;
      }
      // No duration is read here on purpose. The audio element reports the
      // real duration the moment it loads, so probing it first would open a
      // second media element per track for a number that arrives anyway.
      return source;
    },
  };
}