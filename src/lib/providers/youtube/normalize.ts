/**
 * YouTube -> Aurora normalization. Converts validated Data API payloads
 * into Aurora domain types. Nothing YouTube-shaped leaves this module:
 * callers receive `Track` / `Artist` only.
 *
 * Duration contract: `Track.duration` is whole seconds (matching existing
 * usage, e.g. `formatDuration(seconds)`). Missing or unparsable durations
 * stay `undefined` — never invented.
 */

import type { Artist, Track } from "@/lib/domain";
import type {
  YouTubeChannel,
  YouTubePlaylistItem,
  YouTubeSearchItem,
  YouTubeThumbnails,
  YouTubeVideo,
} from "./types";

export const YOUTUBE_PROVIDER_ID = "youtube";

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** True for stable, fetchable video ids (checked before remote calls). */
export function isYouTubeVideoId(value: string): boolean {
  return VIDEO_ID_PATTERN.test(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parses ISO 8601 durations (PT4M13S, PT1H2M, P1DT2H, live "P0D") into
 * whole seconds. Returns undefined for missing/malformed input.
 */
export function parseYouTubeDuration(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.startsWith("P")) {
    return undefined;
  }
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!match) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  if (
    days === undefined &&
    hours === undefined &&
    minutes === undefined &&
    seconds === undefined
  ) {
    return undefined;
  }
  const total =
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  if (!Number.isFinite(total) || total < 0) {
    return undefined;
  }
  return Math.floor(total);
}

export interface NormalizedArtwork {
  small?: string;
  medium?: string;
  large?: string;
  best?: string;
}

/** Maps Data API thumbnails onto semantic sizes (small/medium/large). */
export function normalizeThumbnails(
  thumbnails: YouTubeThumbnails | null | undefined,
): NormalizedArtwork {
  if (!thumbnails || typeof thumbnails !== "object") {
    return {};
  }
  const pick = (entry: { url?: unknown } | null | undefined): string | undefined =>
    asNonEmptyString(entry?.url);
  const small = pick(thumbnails.default);
  const medium = pick(thumbnails.medium);
  const large = pick(thumbnails.high);
  const result: NormalizedArtwork = {};
  if (small) result.small = small;
  if (medium) result.medium = medium;
  if (large) result.large = large;
  const best = large ?? medium ?? small;
  if (best) result.best = best;
  return result;
}

export function youTubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

type LiveState = "live" | "upcoming" | "none" | "unknown";

function liveState(value: unknown): LiveState {
  if (value === "live" || value === "upcoming" || value === "none") {
    return value;
  }
  return "unknown";
}

function privacyStatus(video: YouTubeVideo): string | undefined {
  const status = video.status?.privacyStatus;
  return typeof status === "string" ? status : undefined;
}

/**
 * Conservative availability filter. Skips private/deleted videos and live
 * or upcoming broadcasts (not on-demand songs). Everything else passes —
 * no heuristic music classifier lives here.
 */
export function isAvailableVideo(video: YouTubeVideo): boolean {
  const privacy = privacyStatus(video);
  if (privacy === "private") {
    return false;
  }
  const live = liveState(video.snippet?.liveBroadcastContent);
  if (live === "live" || live === "upcoming") {
    return false;
  }
  return true;
}

export interface NormalizedVideo {
  videoId: string;
  track: Track;
}

/** Normalizes one `videos.list` item. Returns null when identity is missing. */
export function normalizeVideo(video: YouTubeVideo): NormalizedVideo | null {
  const videoId = asNonEmptyString(video.id);
  if (!videoId) {
    return null;
  }
  const title = asNonEmptyString(video.snippet?.title);
  if (!title) {
    return null;
  }
  const channelId = asNonEmptyString(video.snippet?.channelId);
  const channelTitle = asNonEmptyString(video.snippet?.channelTitle) ?? "Unknown artist";
  const artwork = normalizeThumbnails(video.snippet?.thumbnails);
  const duration = parseYouTubeDuration(video.contentDetails?.duration);

  const track: Track = {
    id: videoId,
    provider: YOUTUBE_PROVIDER_ID,
    providerTrackId: videoId,
    title,
    artistId: channelId ?? videoId,
    artistName: channelTitle,
    artworkUrl: artwork.best,
    providerUrl: youTubeWatchUrl(videoId),
    metadata: {
      channelId,
      liveBroadcastContent: video.snippet?.liveBroadcastContent,
      categoryId: video.snippet?.categoryId,
    },
  };
  if (duration !== undefined) {
    track.duration = duration;
  }
  return { videoId, track };
}

/**
 * Normalizes one `search.list` video item. Search results carry no duration
 * (snippet-only); duration resolves on exact lookup. Live/upcoming hits are
 * skipped by the same conservative rule as videos.
 */
export function normalizeSearchItem(item: YouTubeSearchItem): NormalizedVideo | null {
  const videoId = asNonEmptyString(item.id?.videoId);
  if (!videoId) {
    return null;
  }
  const live = liveState(item.snippet?.liveBroadcastContent);
  if (live === "live" || live === "upcoming") {
    return null;
  }
  return normalizeVideo({
    id: videoId,
    snippet: {
      title: item.snippet?.title,
      channelId: item.snippet?.channelId,
      channelTitle: item.snippet?.channelTitle,
      liveBroadcastContent: item.snippet?.liveBroadcastContent,
      thumbnails: item.snippet?.thumbnails ?? null,
    },
  });
}

/** Normalizes one `channels.list` item. Returns null when identity is missing. */
export function normalizeChannel(channel: YouTubeChannel): Artist | null {
  const channelId = asNonEmptyString(channel.id);
  if (!channelId) {
    return null;
  }
  const name = asNonEmptyString(channel.snippet?.title);
  if (!name) {
    return null;
  }
  const artwork = normalizeThumbnails(channel.snippet?.thumbnails);
  const artist: Artist = {
    id: channelId,
    provider: YOUTUBE_PROVIDER_ID,
    providerArtistId: channelId,
    name,
  };
  if (artwork.best) {
    artist.image = artwork.best;
  }
  const bio = asNonEmptyString(channel.snippet?.description);
  if (bio) {
    artist.bio = bio;
  }
  return artist;
}

/** Extracts a channel id from a `search.list` channel item. */
export function channelIdFromSearchItem(item: YouTubeSearchItem): string | null {
  return asNonEmptyString(item.id?.channelId) ?? null;
}

/**
 * Extracts the video id behind a `playlistItems.list` entry, skipping
 * deleted/private placeholders (which carry no usable resourceId).
 */
export function videoIdFromPlaylistItem(item: YouTubePlaylistItem): string | null {
  if (item.status?.privacyStatus === "private") {
    return null;
  }
  const fromResource = asNonEmptyString(item.snippet?.resourceId?.videoId);
  if (fromResource) {
    return fromResource;
  }
  return asNonEmptyString(item.contentDetails?.videoId) ?? null;
}
