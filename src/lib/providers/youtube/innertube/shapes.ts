/**
 * InnerTube -> Data-API-shaped payload extraction (Phase 55).
 *
 * WHY A SHAPE ADAPTER AT ALL. The provider consumes `YouTubeApiTransport`,
 * whose responses are the *Data API v3* shapes (`{ id: { videoId }, snippet:
 * { title, ... } }`). Normalising InnerTube output into those shapes means the
 * provider, the normalizer, and every existing test keep working unchanged,
 * and the choice of data source stops being visible above this file. That is
 * the whole reason the tiered transport is cheap to adopt: the blast radius of
 * adding a second source is one module, not the provider graph.
 *
 * WHY THE READS LOOK DEFENSIVE. InnerTube returns a DIFFERENT NODE FAMILY per
 * surface, and picking the wrong one is silent:
 *
 * - `yt.search(q, { type: "video" })` -> `Video` nodes. `video_id` (a bare
 *   string), `title.text`, `author.{name,id}`, `thumbnails[]`, `length_text`,
 *   `view_count`, `published`, `badges[]`.
 * - `yt.search(q, { type: "channel" })` -> `Channel` nodes. `id` (the UC id),
 *   `author.{name,id,thumbnails}`, `subscriber_count`, `video_count`.
 * - `channel.getVideos()` -> `LockupView` nodes (inside `RichItem` wrappers),
 *   carrying `content_id` + `content_type` and a `metadata` block.
 * - `getInfo` -> `basic_info` with `author` as a plain STRING, the channel id
 *   as `channel_id`, and thumbnails at `basic_info.thumbnail` — not at the
 *   top level.
 *
 * This module originally documented "v18 search results are all `LockupView`".
 * That was a belief, not a measurement, and it was wrong: a live
 * `type: "video"` search returns `Video` nodes. Because the adapter skipped
 * rows it did not recognise rather than throwing, the failure mode was an
 * empty result — which the quality gate correctly read as "parser broke" and
 * routed to the official API. Every test passed and the phase saved no quota
 * at all. So the readers here accept BOTH families deliberately, and the tests
 * for them are built from captured live payloads rather than from hand-written
 * fixtures that merely agreed with the assumption.
 *
 * Untrusted-input discipline: this is a library payload, read exactly the way
 * an HTTP response body would be.
 */

import { asNonEmptyString, asRecord, asText, parseDurationToMs } from "./session";
import type { YouTubeThumbnails } from "../types";

/** A YouTube video id is 11 characters of URL-safe base64. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function isVideoId(value: unknown): value is string {
  return typeof value === "string" && VIDEO_ID.test(value);
}

/** Liveness as the Data API reports it (`liveBroadcastContent`). */
export type Liveness = "none" | "live" | "upcoming";

function toThumbnails(value: unknown): YouTubeThumbnails | undefined {
  // InnerTube exposes an array of `{ url, width, height }`; the Data API
  // exposes named buckets. Artwork selection downstream reads the buckets, so
  // size-ordered buckets are synthesised from the array. Ordering is by
  // descending area so `default`/`high`/`medium` carry the same relative
  // quality the Data API would have given.
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const sized = value
    .map((entry) => asRecord(entry))
    .map((entry) => {
      const url = asNonEmptyString(entry?.url);
      const width = typeof entry?.width === "number" ? Math.floor(entry.width) : 0;
      const height = typeof entry?.height === "number" ? Math.floor(entry.height) : 0;
      return url ? { url, width, height } : null;
    })
    .filter((entry): entry is { url: string; width: number; height: number } => entry !== null)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  if (sized.length === 0) {
    return undefined;
  }
  const first = sized[0]!;
  const middle = sized[Math.min(1, sized.length - 1)]!;
  const last = sized[sized.length - 1]!;
  return {
    default: first,
    medium: middle,
    high: first.width >= 320 ? first : last,
  };
}

function livenessFromBadges(node: Record<string, unknown>): Liveness {
  const badges = node.badges;
  const text = Array.isArray(badges)
    ? badges.map((badge) => asText(asRecord(badge)?.label) ?? "").join(" ")
    : "";
  if (/\blive\b/i.test(text)) {
    return "live";
  }
  if (/\b(upcoming|scheduled|livestream)\b/i.test(text)) {
    return "upcoming";
  }
  return "none";
}

/**
 * Tokens that are never a channel name, as they appear in a `LockupView`
 * metadata row.
 *
 * The view count is a BARE number with a magnitude suffix and no unit word —
 * captured live as `"5.1M"`, `"1M"`, `"42M"` — so a filter that looks for the
 * word "views" does not catch it. An earlier version of this file filtered
 * `^\d[\d.,]*\s*views?` and consequently returned the string `"5.1M"` as a
 * track's channel name, which is worse than returning nothing: it is a
 * confident wrong answer that flows into matching and display.
 */
const NOT_A_NAME =
  /^(?:\d[\d.,]*\s*[KMB]?|no\s+views?|views?|watching|live|upcoming|premiere|\d[\d.,]*\s*(?:views?|watching))\b/i;
const NOT_A_NAME_TAIL =
  /\b(?:views?|watching|ago|stream|premieres?|streams?)\b\s*$/i;

/** A relative age label: "2mo ago", "3 years ago", "in 2 days". */
const AGE_LABEL =
  /^(?:in\s+)?\d+\s*(?:second|minute|hour|day|week|month|year)s?(?:\s+ago)?$/i;

/** The channel display name, wherever this node keeps it. */
function authorName(record: Record<string, unknown>): string | undefined {
  const author = asRecord(record.author);
  const direct =
    asText(author?.name) ?? asText(asRecord(record.owner)?.name) ?? asText(record.author);
  if (direct) {
    return direct;
  }
  // `LockupView` puts the byline in a metadata row rather than on the node:
  // `metadata.metadata.metadata_rows[].metadata_parts[].text`.
  //
  // MEASURED ordering on a channel's videos tab: the byline comes FIRST, as one
  // or more consecutive parts (`["Sơn Tùng M-TP Official", "and Tyga", "42M",
  // "3mo ago"]`), then the view count, then the age. So the byline is the
  // leading run of name-shaped parts, and it must be JOINED — a video credited
  // to two artists is one channel name in the Data API and two parts here.
  const rows = asRecord(asRecord(record.metadata)?.metadata)?.metadata_rows;
  if (Array.isArray(rows)) {
    const byline: string[] = [];
    for (const row of rows) {
      const parts = asRecord(row)?.metadata_parts;
      if (!Array.isArray(parts)) {
        continue;
      }
      for (const part of parts) {
        const label = asText(asRecord(part)?.text);
        if (!label) {
          break;
        }
        if (
          NOT_A_NAME.test(label) ||
          NOT_A_NAME_TAIL.test(label) ||
          AGE_LABEL.test(label) ||
          /^\d/.test(label)
        ) {
          break;
        }
        byline.push(label);
      }
      if (byline.length > 0) {
        break;
      }
    }
    if (byline.length > 0) {
      return byline.join(" ");
    }
  }
  return undefined;
}

/** The channel id, when this node keeps one. Optional everywhere. */
function authorId(record: Record<string, unknown>): string | undefined {
  const author = asRecord(record.author);
  return (
    asNonEmptyString(record.channel_id) ??
    asNonEmptyString(author?.id) ??
    asNonEmptyString(
      asRecord(asRecord(author?.navigation_endpoint)?.payload)?.browseId,
    ) ??
    asNonEmptyString(asRecord(asRecord(record.endpoint)?.payload)?.browseId)
  );
}

/**
 * A video from any InnerTube list node, in Data API `search.list` shape.
 * Returns null when the video id cannot be established with confidence.
 */
export function videoSearchItem(node: unknown): {
  id: { videoId: string };
  snippet: {
    title: string;
    channelId?: string;
    channelTitle?: string;
    liveBroadcastContent: Liveness;
    thumbnails?: YouTubeThumbnails | null;
  };
} | null {
  const record = asRecord(node);
  if (!record) {
    return null;
  }
  // LockupView (v18 search results) and VideoItem (playlist rows, older
  // surfaces) put the id in different places. Both are accepted; anything
  // else is skipped.
  const contentType = asNonEmptyString(record.content_type);
  const candidateId =
    asNonEmptyString(record.content_id) ??
    asNonEmptyString(asRecord(record.id)?.videoId) ??
    asNonEmptyString(asRecord(asRecord(record.endpoint)?.payload)?.videoId) ??
    asNonEmptyString(record.set_video_id) ??
    asNonEmptyString(record.video_id) ??
    asNonEmptyString(record.id);
  if (!isVideoId(candidateId)) {
    return null;
  }
  // A LockupView that says PLAYLIST/ALBUM/CHANNEL is not a track. Only an
  // explicit non-video type is rejected: an unknown type is allowed through
  // and judged by the id, because a future video container may not declare
  // `content_type` at all.
  if (contentType !== undefined && contentType !== "VIDEO" && contentType !== "SHORT") {
    return null;
  }

  const metadata = asRecord(record.metadata);
  const title =
    asText(record.title) ??
    asText(metadata?.title) ??
    asNonEmptyString(
      asRecord(asRecord(metadata?.image)?.decorated_avatar_view_model)?.title,
    ) ??
    asNonEmptyString(record.headline) ??
    "";
  if (title.length === 0) {
    return null;
  }

  const channelId = authorId(record);
  const channelTitle = authorName(record);

  const thumbnails =
    toThumbnails(record.thumbnails) ??
    toThumbnails(asRecord(record.content_image)?.image) ??
    toThumbnails(record.thumbnail) ??
    undefined;

  return {
    id: { videoId: candidateId },
    snippet: {
      title,
      ...(channelId ? { channelId } : {}),
      ...(channelTitle ? { channelTitle } : {}),
      liveBroadcastContent: livenessFromBadges(record),
      ...(thumbnails ? { thumbnails } : {}),
    },
  };
}

/**
 * A channel from any InnerTube list node, in Data API `search.list type=channel`
 * shape.
 *
 * Two families occur. A typed channel search returns `Channel` nodes — `id`,
 * `author.{name,id,thumbnails}`, `subscriber_count`, `video_count` — where the
 * DISPLAY NAME lives in `author.name`, not in a `title` and not in a `metadata`
 * block. A shelf or the older search surface returns a `LockupView` with
 * `content_type === 'CHANNEL'`. Both are accepted; a node that establishes
 * neither a `UC` id nor a name is skipped.
 */
export function channelSearchItem(node: unknown): {
  id: { channelId: string };
  snippet: { title: string; thumbnails?: YouTubeThumbnails | null };
} | null {
  const record = asRecord(node);
  if (!record) {
    return null;
  }
  // A node that says what it is must BE a channel. Without this, a `Video`
  // row's `author.id` is a perfectly good `UC…` string and the video was
  // accepted as an artist — which is how a video becomes an "artist" that is
  // then asked for tracks. `type` is the discriminator the library gives us,
  // so it is checked before any id is mined.
  const nodeType = asNonEmptyString(record.type);
  if (nodeType !== undefined && nodeType !== "Channel" && nodeType !== "LockupView") {
    return null;
  }
  const contentType = asNonEmptyString(record.content_type);
  if (contentType !== undefined && contentType !== "CHANNEL") {
    return null;
  }
  const channelId =
    asNonEmptyString(record.content_id) ??
    asNonEmptyString(asRecord(record.id)?.channelId) ??
    asNonEmptyString(asRecord(asRecord(record.endpoint)?.payload)?.browseId) ??
    asNonEmptyString(
      asRecord(asRecord(asRecord(record.author)?.navigation_endpoint)?.payload)?.browseId,
    ) ??
    asNonEmptyString(record.id);
  // Channel ids are `UC` + 22 chars. Requiring the prefix is what keeps a
  // video id from being read as a channel id: both are 11-ish opaque strings
  // and only one of them is a channel.
  if (!channelId || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    return null;
  }
  const metadata = asRecord(record.metadata);
  const author = asRecord(record.author);
  const title =
    asText(record.title) ??
    asText(metadata?.title) ??
    // `Channel` nodes: the name is the author's name.
    asText(author?.name) ??
    asText(record.long_byline) ??
    asText(record.short_byline) ??
    asNonEmptyString(
      asRecord(asRecord(asRecord(record.author)?.navigation_endpoint)?.payload)?.title,
    ) ??
    asNonEmptyString(record.headline) ??
    "";
  if (title.length === 0) {
    return null;
  }
  const thumbnails =
    toThumbnails(record.thumbnails) ??
    toThumbnails(author?.thumbnails) ??
    toThumbnails(asRecord(record.content_image)?.image) ??
    toThumbnails(asRecord(record.image)?.thumbnails) ??
    undefined;
  return {
    id: { channelId },
    snippet: { title, ...(thumbnails ? { thumbnails } : {}) },
  };
}

/**
 * A `getInfo` response as a Data API `videos.list` item.
 *
 * `getInfo` is strictly better than `videos.list` for our needs: it returns a
 * real numeric `duration` in seconds (the Data API returns an ISO-8601
 * `PT#M#S` string that has to be parsed), and it returns liveness as booleans
 * rather than a badge string.
 */
export function videoInfoItem(info: unknown, videoId: string): {
  id: string;
  snippet: {
    title: string;
    channelId?: string;
    channelTitle?: string;
    liveBroadcastContent: Liveness;
    thumbnails?: YouTubeThumbnails | null;
  };
  /**
   * OMITTED when the duration is unknown, rather than emitted as `PT0S`.
   *
   * `parseYouTubeDuration("PT0S")` returns `0`, so a placeholder would set
   * `Track.duration = 0` and the UI would render a real track as "0:00" —
   * a visible wrong answer where the truth is "unknown". The Data API omits
   * `contentDetails` for a video it cannot describe, which leaves
   * `Track.duration` unset; this matches that, and `parseYouTubeDuration`
   * already returns undefined for a missing part.
   */
  contentDetails?: { duration: string };
  status: { privacyStatus: string; uploadStatus: string };
} | null {
  const record = asRecord(info);
  const basic = asRecord(record?.basic_info);
  if (!basic) {
    return null;
  }
  const title = asText(basic.title) ?? videoId;
  // `basic_info.author` is a plain STRING on a live response, not an author
  // object. Reading it as a record returned null, which silently dropped the
  // channel name from every hydrated track — and `asRecord` does not throw, so
  // nothing anywhere reported a problem. The object form is still accepted
  // because the library's own type declares it.
  const authorRecord = asRecord(basic.author);
  const channelId =
    asNonEmptyString(basic.channel_id) ?? asNonEmptyString(authorRecord?.id) ?? undefined;
  const channelTitle =
    asText(basic.author) ?? asText(authorRecord?.name) ?? undefined;
  const durationSeconds =
    typeof basic.duration === "number" &&
    Number.isFinite(basic.duration) &&
    basic.duration > 0
      ? basic.duration
      : undefined;
  // Thumbnails live at `basic_info.thumbnail`, not at the top level. The
  // top-level read is kept for older shapes.
  const thumbnails =
    toThumbnails(basic.thumbnail) ?? toThumbnails(record?.thumbnails) ?? undefined;
  const isLive = basic.is_live_content === true;
  const isUpcoming = basic.is_upcoming === true;
  return {
    id: videoId,
    snippet: {
      title,
      ...(channelId ? { channelId } : {}),
      ...(channelTitle ? { channelTitle } : {}),
      liveBroadcastContent: isLive ? "live" : isUpcoming ? "upcoming" : "none",
      ...(thumbnails ? { thumbnails } : {}),
    },
    // ISO-8601, which is what the normalizer already parses.
    ...(durationSeconds !== undefined
      ? { contentDetails: { duration: `PT${Math.floor(durationSeconds)}S` } }
      : {}),
    status: { privacyStatus: "public", uploadStatus: "processed" },
  };
}

/** Exported for the playlist transport, which reads a `Duration` column. */
export { parseDurationToMs };
