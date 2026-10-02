/**
 * Deterministic audio-format selection for browser playback.
 *
 * Policy (documented, no magic):
 * 1. Audio-only with a usable URL first. When YouTube withholds
 *    audio-only URLs for a context (Phase 17 runtime finding), a muxed
 *    audio+video format with a usable URL is an acceptable LAST resort:
 *    HTMLAudioElement extracts the audio track and AAC-in-mp4 stays
 *    Safari-safe. Video-carrying formats never outrank audio-only ones,
 *    and URL-less formats are never eligible.
 * 2. Browser-compatible MIME first: `audio/mp4` (AAC, Safari-safe) beats
 *    `audio/webm` (Opus, no Safari support), which beats other audio types.
 *    The same ranking applies within the muxed fallback tier.
 * 3. Higher reported bitrate wins among equivalent containers. Missing
 *    bitrate sorts last, never estimated.
 * 4. Final tie-break is the URL lexicographically: arbitrary but stable,
 *    so selection never depends on upstream array order.
 *
 * Pure: no network, no library imports, fully testable with fixtures.
 */

import type { PlaybackFormatCandidate } from "./types";

function mimeRank(mimeType: string | undefined): number {
  if (!mimeType) {
    return 3;
  }
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base === "audio/mp4" || base === "audio/m4a" || base === "audio/aac") {
    return 0;
  }
  if (base === "audio/webm") {
    return 1;
  }
  if (base.startsWith("audio/")) {
    return 2;
  }
  return 3;
}

function bitrateRank(bitrate: number | undefined): number {
  return typeof bitrate === "number" && Number.isFinite(bitrate) && bitrate > 0
    ? bitrate
    : -1;
}

/**
 * Returns every eligible audio format in preference order (best first).
 * Audio-only wins; muxed audio+video is a last resort; deterministic for
 * identical inputs regardless of input order.
 *
 * The resolver walks this ranking and validates each winner against the
 * provider before handing it out, so a top-ranked format the browser
 * cannot consume falls through to the next candidate instead of failing
 * playback deterministically on every re-resolution.
 */
export function rankAudioFormats(
  candidates: PlaybackFormatCandidate[],
): PlaybackFormatCandidate[] {
  const withUrl = candidates.filter(
    (candidate) =>
      candidate.hasAudio &&
      typeof candidate.url === "string" &&
      candidate.url.length > 0,
  );
  return [...withUrl].sort((a, b) => {
    // Audio-only outranks muxed before any MIME/bitrate comparison.
    const video = Number(a.hasVideo) - Number(b.hasVideo);
    if (video !== 0) {
      return video;
    }
    const mime = mimeRank(a.mimeType) - mimeRank(b.mimeType);
    if (mime !== 0) {
      return mime;
    }
    const bitrate = bitrateRank(b.bitrate) - bitrateRank(a.bitrate);
    if (bitrate !== 0) {
      return bitrate;
    }
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}
