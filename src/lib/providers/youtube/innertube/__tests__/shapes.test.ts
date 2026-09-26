import { describe, expect, it } from "vitest";
import {
  channelSearchItem,
  isVideoId,
  videoInfoItem,
  videoSearchItem,
} from "@/lib/providers/youtube/innertube/shapes";
import { normalizeSearchItem, normalizeVideo } from "@/lib/providers/youtube/normalize";

/**
 * §39 / §76. InnerTube payloads are untrusted input of exactly the same kind
 * as an HTTP response body, and in `youtubei.js@18.0.0` YouTube's search
 * results are `LockupView` nodes — the library has no `VideoItem` type at all.
 * These tests pin the shapes that actually ship, so a markup change shows up
 * here as a failing test rather than as an empty search page in production.
 */

const VIDEO_ID = "dQw4w9WgXcQ";
const CHANNEL_ID = "UCuAXFkgsw1L7xaCfnd5JJOw";

/** The v18 search result: a LockupView with the channel in a metadata row. */
function lockupVideo(overrides: Record<string, unknown> = {}): unknown {
  return {
    content_type: "VIDEO",
    content_id: VIDEO_ID,
    content_image: {
      image: [
        { url: "https://i.example/sd.jpg", width: 120, height: 90 },
        { url: "https://i.example/hd.jpg", width: 480, height: 360 },
        { url: "https://i.example/max.jpg", width: 1280, height: 720 },
      ],
    },
    metadata: {
      title: { text: "Lạc Trôi - Sơn Tùng M-TP" },
      metadata: {
        delimiter: " • ",
        metadata_rows: [
          {
            metadata_parts: [
              { text: { text: "Sơn Tùng M-TP" } },
              { text: { text: "1.2M views" } },
              { text: { text: "5 years ago" } },
            ],
          },
        ],
      },
    },
    ...overrides,
  };
}

describe("video ids", () => {
  it("accepts only 11-character URL-safe base64", () => {
    expect(isVideoId(VIDEO_ID)).toBe(true);
    expect(isVideoId("dQw4w9WgXc")).toBe(false);
    expect(isVideoId("dQw4w9WgXcQQ")).toBe(false);
    expect(isVideoId("dQw4w9WgXc!")).toBe(false);
    // A channel id is 24 characters and is not a video id, so it can never be
    // mistaken for one by the id check alone.
    expect(isVideoId(CHANNEL_ID)).toBe(false);
  });
});

describe("videoSearchItem", () => {
  it("reads a v18 LockupView into Data API search shape", () => {
    const item = videoSearchItem(lockupVideo());
    expect(item).not.toBeNull();
    expect(item?.id.videoId).toBe(VIDEO_ID);
    expect(item?.snippet.title).toBe("Lạc Trôi - Sơn Tùng M-TP");
  });

  it("takes the channel name from the metadata byline, not from a view count", () => {
    // This is the field that decides the artist name, and therefore decides
    // whether TrackMatcher can match anything at all. Reading the wrong
    // metadata part would make every track an "Unknown artist".
    const item = videoSearchItem(lockupVideo());
    expect(item?.snippet.channelTitle).toBe("Sơn Tùng M-TP");
  });

  it("feeds the existing normalizer unchanged", () => {
    // The whole reason for the shape adapter: the provider, the normalizer and
    // every existing test keep working without knowing which source answered.
    const item = videoSearchItem(lockupVideo());
    const normalized = normalizeSearchItem(
      item as Parameters<typeof normalizeSearchItem>[0],
    );
    expect(normalized).not.toBeNull();
    expect(normalized?.track.provider).toBe("youtube");
    expect(normalized?.track.providerTrackId).toBe(VIDEO_ID);
    expect(normalized?.track.title).toBe("Lạc Trôi - Sơn Tùng M-TP");
    // The artist name is what TrackMatcher matches on, and it comes from the
    // byline read in the adapter.
    expect(normalized?.track.artistName).toBe("Sơn Tùng M-TP");
    expect(normalized?.track.artworkUrl).toBe("https://i.example/max.jpg");
  });

  it("orders thumbnails by size so artwork selection picks the largest", () => {
    const item = videoSearchItem(lockupVideo());
    // `high` is what the artwork picker prefers, and it must not be the 120px
    // thumbnail just because YouTube listed it first.
    expect(item?.snippet.thumbnails?.high?.url).toBe("https://i.example/max.jpg");
  });

  it("reads a legacy VideoItem shape too", () => {
    // Older surfaces and playlist rows still use this shape. Accepting both
    // costs nothing and survives a partial migration.
    const item = videoSearchItem({
      video_id: VIDEO_ID,
      title: { text: "Old shape" },
      author: { name: "Someone", id: CHANNEL_ID },
      thumbnails: [{ url: "https://i.example/a.jpg", width: 320, height: 180 }],
    });
    expect(item?.id.videoId).toBe(VIDEO_ID);
    expect(item?.snippet.title).toBe("Old shape");
    expect(item?.snippet.channelId).toBe(CHANNEL_ID);
    expect(item?.snippet.channelTitle).toBe("Someone");
  });

  it("rejects a non-video container rather than returning a playlist as a track", () => {
    // A playlist row in a search result is not a playable track. Returning it
    // would produce a Track whose id is a playlist id and never plays.
    expect(
      videoSearchItem({ content_type: "PLAYLIST", content_id: "PLabcdefghijk" }),
    ).toBeNull();
    expect(
      videoSearchItem({ content_type: "CHANNEL", content_id: CHANNEL_ID }),
    ).toBeNull();
  });

  it("skips a node whose id cannot be established rather than guessing", () => {
    // The asymmetry the quality gate depends on: a skipped node reduces recall,
    // and the gate notices the reduced item count and routes to the official
    // API. A guessed id would be a wrong track that looks right.
    expect(videoSearchItem({ content_type: "VIDEO" })).toBeNull();
    expect(videoSearchItem({ content_type: "VIDEO", content_id: "short" })).toBeNull();
    expect(videoSearchItem(null)).toBeNull();
    expect(videoSearchItem("a string")).toBeNull();
    expect(videoSearchItem(42)).toBeNull();
  });

  it("skips a node with no title", () => {
    expect(videoSearchItem({ content_type: "VIDEO", content_id: VIDEO_ID })).toBeNull();
  });

  it("detects live and upcoming badges", () => {
    const live = videoSearchItem(
      lockupVideo({ badges: [{ label: { text: "LIVE" } }] }),
    );
    expect(live?.snippet.liveBroadcastContent).toBe("live");
    const upcoming = videoSearchItem(
      lockupVideo({ badges: [{ label: { text: "Scheduled for tomorrow" } }] }),
    );
    expect(upcoming?.snippet.liveBroadcastContent).toBe("upcoming");
    const normal = videoSearchItem(lockupVideo());
    expect(normal?.snippet.liveBroadcastContent).toBe("none");
  });

  it("does not render a Text node as the string [object Object]", () => {
    // The default failure of any `String(node)` shortcut. A track titled
    // "[object Object]" is worse than a skipped track.
    const item = videoSearchItem({
      content_type: "VIDEO",
      content_id: VIDEO_ID,
      metadata: { title: { notText: true, nested: { deeper: 1 } } },
    });
    expect(item).toBeNull();
  });

  it("survives a Text node that only has a toString", () => {
    const item = videoSearchItem({
      content_type: "VIDEO",
      content_id: VIDEO_ID,
      metadata: { title: { toString: () => "Rendered title" } },
    });
    expect(item?.snippet.title).toBe("Rendered title");
  });
});

describe("channelSearchItem", () => {
  it("reads a channel LockupView", () => {
    const item = channelSearchItem({
      content_type: "CHANNEL",
      content_id: CHANNEL_ID,
      metadata: { title: { text: "Sơn Tùng M-TP" } },
    });
    expect(item?.id.channelId).toBe(CHANNEL_ID);
    expect(item?.snippet.title).toBe("Sơn Tùng M-TP");
  });

  it("rejects a video id presented as a channel", () => {
    // Both are opaque strings of similar length. Only the `UC` prefix
    // distinguishes them, and requiring it is what stops `search.artists` from
    // returning videos as artists — which would then be asked for tracks and
    // produce an artist page full of unrelated rows.
    expect(
      channelSearchItem({ content_type: "CHANNEL", content_id: VIDEO_ID }),
    ).toBeNull();
  });

  it("rejects non-channel containers and unusable nodes", () => {
    expect(channelSearchItem(lockupVideo())).toBeNull();
    expect(channelSearchItem({ content_id: CHANNEL_ID })).toBeNull();
    expect(channelSearchItem(null)).toBeNull();
  });
});

describe("videoInfoItem", () => {
  it("converts a getInfo response into videos.list shape", () => {
    const item = videoInfoItem(
      {
        basic_info: {
          title: "Lạc Trôi",
          author: { name: "Sơn Tùng M-TP", id: CHANNEL_ID },
          duration: 253,
          is_live_content: false,
          is_upcoming: false,
        },
        thumbnails: [{ url: "https://i.example/hd.jpg", width: 480, height: 360 }],
      },
      VIDEO_ID,
    );
    expect(item?.id).toBe(VIDEO_ID);
    expect(item?.snippet.title).toBe("Lạc Trôi");
    expect(item?.snippet.channelId).toBe(CHANNEL_ID);
    // ISO-8601, because that is what the existing normalizer parses. Emitting
    // seconds here would make duration silently zero for every track.
    expect(item?.contentDetails?.duration).toBe("PT253S");
  });

  it("reports liveness from getInfo's booleans", () => {
    const live = videoInfoItem(
      { basic_info: { title: "x", duration: 10, is_live_content: true } },
      VIDEO_ID,
    );
    expect(live?.snippet.liveBroadcastContent).toBe("live");
    const upcoming = videoInfoItem(
      { basic_info: { title: "x", duration: 10, is_upcoming: true } },
      VIDEO_ID,
    );
    expect(upcoming?.snippet.liveBroadcastContent).toBe("upcoming");
  });

  it("feeds the existing video normalizer unchanged", () => {
    const item = videoInfoItem(
      {
        basic_info: { title: "Lạc Trôi", author: { name: "Sơn Tùng" }, duration: 253 },
        thumbnails: [{ url: "https://i.example/hd.jpg", width: 480, height: 360 }],
      },
      VIDEO_ID,
    );
    const normalized = normalizeVideo(item as Parameters<typeof normalizeVideo>[0]);
    expect(normalized?.track.providerTrackId).toBe(VIDEO_ID);
    // Whole seconds, matching `Track.duration` usage elsewhere.
    expect(normalized?.track.duration).toBe(253);
    expect(normalized?.track.artistName).toBe("Sơn Tùng");
  });

  it("omits the duration part when getInfo does not know it", () => {
    const item = videoInfoItem({ basic_info: { title: "x" } }, VIDEO_ID);
    // Not `PT0S`: `parseYouTubeDuration("PT0S")` is 0, which would render a
    // real track as "0:00" instead of leaving the duration unknown.
    expect(item?.contentDetails).toBeUndefined();
    const normalized = normalizeVideo(item as Parameters<typeof normalizeVideo>[0]);
    expect(normalized?.track.duration).toBeUndefined();
  });

  it("does not treat a live stream's zero duration as a known length", () => {
    const item = videoInfoItem(
      { basic_info: { title: "x", duration: 0, is_live_content: true } },
      VIDEO_ID,
    );
    expect(item?.contentDetails).toBeUndefined();
    expect(item?.snippet.liveBroadcastContent).toBe("live");
  });

  it("rejects a response with no basic_info at all", () => {
    expect(videoInfoItem({}, VIDEO_ID)).toBeNull();
    expect(videoInfoItem(null, VIDEO_ID)).toBeNull();
  });

  it("falls back to the video id as a title rather than dropping the track", () => {
    // A known, playable id is worth keeping: playback works, and the id is
    // displayable. Dropping it would lose a track that plays.
    const item = videoInfoItem({ basic_info: { duration: 10 } }, VIDEO_ID);
    expect(item?.snippet.title).toBe(VIDEO_ID);
  });
});

/**
 * CAPTURED PAYLOADS, NOT ASSUMPTIONS.
 *
 * Every fixture below was copied out of a live `youtubei.js@18.0.0` response
 * during Phase 55, because the hand-written fixtures above agreed with the
 * author's belief and the belief was wrong. The specific failures they hid:
 *
 * 1. A typed video search returns `Video` nodes, not `LockupView`. The adapter
 *    skipped every real row, the quality gate read the empty result as a parse
 *    failure, and every search fell back to the official API — so the phase
 *    saved no quota while every test passed.
 * 2. A typed channel search returns `Channel` nodes whose display name is
 *    `author.name`, with no `title` and no `metadata` block anywhere.
 * 3. `getInfo` returns `basic_info.author` as a plain STRING and puts
 *    thumbnails at `basic_info.thumbnail`, not at the top level.
 * 4. A `LockupView` view count is a BARE magnitude — `"5.1M"`, with no "views"
 *    word — so a byline filter that looks for "views" returns `"5.1M"` as a
 *    channel name. The hand-written fixture used `"1.2M views"`, which the old
 *    filter rejected, so the bug never showed.
 *
 * Rule for this file going forward: a new fixture is added by capturing a real
 * response, not by describing one.
 */
describe("captured live payloads (youtubei.js@18.0.0)", () => {
  /** `yt.search(q, { type: "video" })` row, verbatim keys. */
  const liveVideoRow = {
    type: "Video",
    video_id: "SlQR9iu09bQ",
    title: {
      text: "SON TUNG M-TP x TYGA | COME MY WAY | OFFICIAL MUSIC VIDEO",
      runs: [{ text: "SON TUNG M-TP x TYGA | COME MY WAY | OFFICIAL MUSIC VIDEO" }],
    },
    author: {
      id: "UClyA28-01x4z60eWQ2kiNbA",
      name: "Sơn Tùng M-TP Official",
    },
    thumbnails: [
      { url: "https://i.ytimg.com/vi/SlQR9iu09bQ/hqdefault.jpg", width: 480, height: 360 },
      { url: "https://i.ytimg.com/vi/SlQR9iu09bQ/maxresdefault.jpg", width: 1280, height: 720 },
    ],
    length_text: { text: "3:55" },
    view_count: { text: "42,308,192 views" },
    published: { text: "3mo ago" },
    badges: [],
  };

  /** `yt.search(q, { type: "channel" })` row, verbatim keys. */
  const liveChannelRow = {
    type: "Channel",
    id: "UClyA28-01x4z60eWQ2kiNbA",
    author: {
      id: "UClyA28-01x4z60eWQ2kiNbA",
      name: "Sơn Tùng M-TP Official",
      thumbnails: [{ url: "https://yt3.ggpht.com/avatar=s176", width: 176, height: 176 }],
    },
    subscriber_count: { text: "3.4M subscribers" },
    video_count: { text: "200 videos" },
  };

  it("reads a real Video node — the shape a typed search actually returns", () => {
    const item = videoSearchItem(liveVideoRow);
    expect(item).not.toBeNull();
    expect(item?.id.videoId).toBe("SlQR9iu09bQ");
    expect(item?.snippet.title).toBe(
      "SON TUNG M-TP x TYGA | COME MY WAY | OFFICIAL MUSIC VIDEO",
    );
    expect(item?.snippet.channelId).toBe("UClyA28-01x4z60eWQ2kiNbA");
    expect(item?.snippet.channelTitle).toBe("Sơn Tùng M-TP Official");
    expect(item?.snippet.thumbnails?.high?.url).toBe(
      "https://i.ytimg.com/vi/SlQR9iu09bQ/maxresdefault.jpg",
    );
  });

  it("normalizes a real Video node into a track with a usable artist", () => {
    // The end-to-end claim of the shape adapter, on a payload that really
    // occurs: the artist name is what TrackMatcher matches on.
    const normalized = normalizeSearchItem(
      videoSearchItem(liveVideoRow) as Parameters<typeof normalizeSearchItem>[0],
    );
    expect(normalized?.track.providerTrackId).toBe("SlQR9iu09bQ");
    expect(normalized?.track.artistName).toBe("Sơn Tùng M-TP Official");
    expect(normalized?.track.artworkUrl).toBe(
      "https://i.ytimg.com/vi/SlQR9iu09bQ/maxresdefault.jpg",
    );
  });

  it("skips the Channel row that a typed VIDEO search also returns", () => {
    // Measured: `{ type: "video" }` comes back as 19 `Video` + 1 `Channel`.
    // The channel's `UC…` id is 24 characters and must not be read as a video.
    expect(videoSearchItem(liveChannelRow)).toBeNull();
  });

  it("reads a real Channel node, whose name lives in author.name", () => {
    const item = channelSearchItem(liveChannelRow);
    expect(item?.id.channelId).toBe("UClyA28-01x4z60eWQ2kiNbA");
    expect(item?.snippet.title).toBe("Sơn Tùng M-TP Official");
    expect(item?.snippet.thumbnails?.default?.url).toBe("https://yt3.ggpht.com/avatar=s176");
  });

  it("rejects a Video node presented to the channel adapter", () => {
    expect(channelSearchItem(liveVideoRow)).toBeNull();
  });

  it("reads a real getInfo payload: string author, channel_id, nested thumbnail", () => {
    const item = videoInfoItem(
      {
        basic_info: {
          id: "SlQR9iu09bQ",
          channel_id: "UClyA28-01x4z60eWQ2kiNbA",
          title: "SON TUNG M-TP x TYGA | COME MY WAY | OFF",
          duration: 235,
          author: "Sơn Tùng M-TP Official",
          is_live: false,
          is_live_content: false,
          is_upcoming: false,
          view_count: 42308192,
          thumbnail: [
            { url: "https://i.ytimg.com/vi/SlQR9iu09bQ/maxres.jpg", width: 1280, height: 720 },
          ],
        },
        // Captured payload has NO top-level `thumbnails`; reading only that
        // path is what silently produced artwork-less tracks.
        streaming_data: {},
        playability_status: {},
      },
      "SlQR9iu09bQ",
    );
    expect(item?.snippet.title).toBe("SON TUNG M-TP x TYGA | COME MY WAY | OFF");
    // A STRING author, not an object — the read that returned null and dropped
    // the channel name from every hydrated track.
    expect(item?.snippet.channelTitle).toBe("Sơn Tùng M-TP Official");
    expect(item?.snippet.channelId).toBe("UClyA28-01x4z60eWQ2kiNbA");
    expect(item?.snippet.thumbnails?.high?.url).toBe(
      "https://i.ytimg.com/vi/SlQR9iu09bQ/maxres.jpg",
    );
    expect(item?.contentDetails?.duration).toBe("PT235S");
  });

  it("does not return a bare view count as a channel name", () => {
    // Captured from a channel's videos tab, where the row carried only a view
    // count and an age. The old filter required the word "views", so it
    // returned "5.1M" — a confident wrong answer that flows into matching and
    // display. Omitting the field is the correct outcome.
    const item = videoSearchItem({
      type: "LockupView",
      content_type: "VIDEO",
      content_id: "yuuWdm5tBD0",
      metadata: {
        title: { text: "COME MY WAY (softer version)" },
        metadata: {
          metadata_rows: [
            {
              metadata_parts: [
                { text: { text: "5.1M" } },
                { text: { text: "2mo ago" } },
              ],
            },
          ],
        },
      },
    });
    expect(item?.id.videoId).toBe("yuuWdm5tBD0");
    expect(item?.snippet.channelTitle).toBeUndefined();
  });

  it("joins a multi-part byline into one channel name", () => {
    // Captured row: ["Sơn Tùng M-TP Official", "and Tyga", "42M", "3mo ago"].
    // A two-artist credit is ONE channel name in the Data API shape, and the
    // `Video` node for the same video yields exactly "Sơn Tùng M-TP Official
    // and Tyga" — so both surfaces must agree.
    const item = videoSearchItem({
      type: "LockupView",
      content_type: "VIDEO",
      content_id: "SlQR9iu09bQ",
      metadata: {
        title: { text: "COME MY WAY" },
        metadata: {
          metadata_rows: [
            {
              metadata_parts: [
                { text: { text: "Sơn Tùng M-TP Official" } },
                { text: { text: "and Tyga" } },
                { text: { text: "42M" } },
                { text: { text: "3mo ago" } },
              ],
            },
          ],
        },
      },
    });
    expect(item?.snippet.channelTitle).toBe("Sơn Tùng M-TP Official and Tyga");
  });

  it("still takes the byline ahead of a count that does carry a unit word", () => {
    // The hand-written fixture's shape, kept so the older path stays covered.
    const item = videoSearchItem(lockupVideo());
    expect(item?.snippet.channelTitle).toBe("Sơn Tùng M-TP");
  });
});
