import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInnerTubeTransport,
  InnerTubeUnavailableError,
  isInnerTubeRateLimited,
  isInnerTubeUnavailable,
} from "@/lib/providers/youtube/innertube/transport";
import {
  resetYouTubeMetrics,
  snapshotYouTubeMetrics,
} from "@/lib/providers/youtube/innertube/metrics";

/**
 * The InnerTube transport, driven by a fake session. No network, no library.
 *
 * The point of these tests is the request COUNT, not the response shape (the
 * shape is covered in `shapes.test.ts`). Every assertion of the form
 * "called N times" is a quota claim.
 */

const VIDEO_ID = "dQw4w9WgXcQ";

function lockup(id: string, title = "Lạc Trôi"): unknown {
  return {
    content_type: "VIDEO",
    content_id: id,
    metadata: { title: { text: title } },
  };
}

/** A session that answers `search`/`getInfo`/`getChannel` from a script. */
function fakeSession(overrides: Record<string, unknown> = {}): {
  session: unknown;
  search: ReturnType<typeof vi.fn>;
  getInfo: ReturnType<typeof vi.fn>;
  getChannel: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn(async () => ({
    results: [lockup(VIDEO_ID), lockup("aaaaaaaaaaa")],
    estimated_results: 2,
    ...(overrides.search as object),
  }));
  const getInfo = vi.fn(async (id: string) => ({
    basic_info: { title: `Track ${id}`, author: { name: "Artist" }, duration: 200 },
    ...(overrides.getInfo as object),
  }));
  const channelShelf = {
    contents: [lockup(VIDEO_ID)],
    getVideos: vi.fn(async () => channelShelf),
    has_videos: true,
  };
  const getChannel = vi.fn(async () => channelShelf);
  const session = {
    search,
    getInfo,
    getChannel,
    getPlaylist: vi.fn(),
  };
  return { session, search, getInfo, getChannel };
}

function transportFor(session: unknown, ttlMs = 60_000): ReturnType<typeof createInnerTubeTransport> {
  return createInnerTubeTransport({
    sessionFactory: async () => session as never,
    searchTtlMs: ttlMs,
    videoTtlMs: ttlMs,
  });
}

/**
 * CAPTURED rows, not described ones.
 *
 * `lockup()` above models a `LockupView`, which is what a channel's videos tab
 * returns. A typed search does NOT return those — it returns `Video` and
 * `Channel` nodes with a different key set. Keeping a fixture for each real
 * family is the point: the first version of this file had only the assumed
 * family, so the adapters passed every test while parsing nothing in
 * production.
 */
function realVideoRow(): unknown {
  return {
    type: "Video",
    video_id: "SlQR9iu09bQ",
    title: { text: "SON TUNG M-TP x TYGA | COME MY WAY" },
    author: { id: "UClyA28-01x4z60eWQ2kiNbA", name: "Sơn Tùng M-TP Official" },
    thumbnails: [{ url: "https://i.ytimg.com/vi/SlQR9iu09bQ/maxres.jpg", width: 1280, height: 720 }],
    length_text: { text: "3:55" },
    view_count: { text: "42,308,192 views" },
    published: { text: "3mo ago" },
    badges: [],
  };
}

function realChannelRow(): unknown {
  return {
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
}

/**
 * A session factory that never settles, counting how many times it was called.
 *
 * `never` rather than a slow resolve, so a test that fails to enforce a
 * deadline fails by TIMING OUT instead of by passing slowly.
 */
function hungSessionFactory(): { factory: () => Promise<never>; attempts: () => number } {
  let attempts = 0;
  return {
    factory: () => {
      attempts += 1;
      return new Promise<never>(() => {});
    },
    attempts: () => attempts,
  };
}

const ms = (start: number): number => Date.now() - start;

beforeEach(() => {
  resetYouTubeMetrics();
});

describe("failure classification (§39, §74)", () => {
  it("separates rate limiting from ordinary failure from 'cannot do this'", () => {
    // Three different conditions with three different responses. One generic
    // "YouTube unavailable" bucket would make all three look the same
    // incident and would retry the wrong one.
    expect(isInnerTubeRateLimited(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isInnerTubeRateLimited(new Error("rate limit exceeded"))).toBe(true);
    expect(isInnerTubeRateLimited(new Error("socket hang up"))).toBe(false);

    expect(isInnerTubeUnavailable(new Error("InnerTube request timed out"))).toBe(true);
    expect(
      isInnerTubeUnavailable(new InnerTubeUnavailableError("getPlaylist", "not implemented")),
    ).toBe(true);
    expect(isInnerTubeUnavailable(new TypeError("x is not a function"))).toBe(false);
  });

  it("routes an unavailable operation to the fallback rather than answering empty", () => {
    const transport = transportFor(fakeSession().session);
    // A transport that answered "no playlists" would be cached as a
    // user-visible "nothing found" and would hide the real problem entirely.
    return expect(transport.getPlaylist("PL1")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
  });

  it("reports a session failure as unavailable so the fallback engages", async () => {
    const transport = transportFor({
      search: async () => {
        throw new Error("InnerTube request timed out");
      },
    });
    await expect(transport.searchVideos("x")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(snapshotYouTubeMetrics().counters.innertube_failed).toBe(1);
  });

  it("records rate limiting under its own counter", async () => {
    const transport = transportFor({
      search: async () => {
        throw new Error("HTTP 429 Too Many Requests");
      },
    });
    await expect(transport.searchVideos("x")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    const counters = snapshotYouTubeMetrics().counters;
    expect(counters.innertube_rate_limited).toBe(1);
    // Not double-counted as a generic failure: the two conditions mean
    // different things and an operator must be able to tell them apart.
    expect(counters.innertube_failed).toBeUndefined();
  });
});

describe("search", () => {
  it("maps results into Data API shape", async () => {
    const transport = transportFor(fakeSession().session);
    const response = await transport.searchVideos("son tung", { limit: 10 });
    expect(response.items).toHaveLength(2);
    const items = response.items as Array<{ id: { videoId: string } }>;
    expect(items[0]?.id.videoId).toBe(VIDEO_ID);
  });

  it("collapses ten identical searches inside the TTL into one upstream call", async () => {
    // §59, the headline scenario: ten searches must not be ten quota events.
    const { session, search } = fakeSession();
    const transport = transportFor(session);
    for (let index = 0; index < 10; index += 1) {
      await transport.searchVideos("son tung", { limit: 10 });
    }
    expect(search).toHaveBeenCalledOnce();
    expect(snapshotYouTubeMetrics().counters["search.cache_hit"]).toBe(9);
  });

  it("collapses concurrent identical searches into one upstream call", async () => {
    // §14 / §62: three components asking at the same moment is one request.
    const { session, search } = fakeSession();
    const transport = transportFor(session);
    await Promise.all([
      transport.searchVideos("son tung", { limit: 10 }),
      transport.searchVideos("son tung", { limit: 10 }),
      transport.searchVideos("son tung", { limit: 10 }),
    ]);
    expect(search).toHaveBeenCalledOnce();
    expect(snapshotYouTubeMetrics().counters["search.dedupe_hit"]).toBe(2);
  });

  it("re-asks once the TTL expires", async () => {
    // A cache that never expires is a cache that serves last week's answer.
    vi.useFakeTimers();
    try {
      const { session, search } = fakeSession();
      const transport = transportFor(session, 5_000);
      await transport.searchVideos("son tung");
      vi.advanceTimersByTime(5_001);
      await transport.searchVideos("son tung");
      expect(search).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats DIFFERENT queries as different requests", async () => {
    // Collapsing these would be wrong, not efficient: "son tung" and
    // "son tung 2019" have different answers.
    const { session, search } = fakeSession();
    const transport = transportFor(session);
    await transport.searchVideos("son tung");
    await transport.searchVideos("son tung 2019");
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("caches a no-result query for the short negative window only", async () => {
    // §17. A search that legitimately has no results is still an upstream
    // call, so it must be cached — but briefly, because a track can be
    // uploaded later and a permanent "no results" would be a lie.
    vi.useFakeTimers();
    try {
      const session = { search: vi.fn(async () => ({ results: [] })) };
      const transport = transportFor(session, 60_000);
      await transport.searchVideos("zzzz");
      await transport.searchVideos("zzzz");
      expect(session.search).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(60_001);
      await transport.searchVideos("zzzz");
      expect(session.search).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks for the minimum useful result count", async () => {
    // §29: the UI needs 8-20, not 50-100. A cap here also bounds the parse
    // cost of a large InnerTube payload.
    const { session } = fakeSession();
    const transport = transportFor(session);
    await transport.searchVideos("x", { limit: 500 });
    const response = await transport.searchVideos("y", { limit: 500 });
    expect(response.items).toHaveLength(2);
    expect((response.items as unknown[]).length).toBeLessThanOrEqual(25);
  });

  it("requests the channel uploads tab, not the curated home tab", async () => {
    const { session, getChannel } = fakeSession();
    const transport = transportFor(session);
    const response = await transport.searchChannelVideos("UCabc", { limit: 10 });
    expect(getChannel).toHaveBeenCalledWith("UCabc");
    expect(response.items).toHaveLength(1);
  });

  it("uses the channel's own videos tab when it has one", async () => {
    // `getHome()` is a curated mix and is not a catalogue; asking for the
    // videos tab is what makes `artists.tracks` mean "this artist's tracks".
    const shelf = { contents: [lockup(VIDEO_ID)], getVideos: vi.fn(), has_videos: true };
    const session = { search: vi.fn(), getInfo: vi.fn(), getChannel: vi.fn(async () => shelf) };
    const transport = transportFor(session);
    await transport.searchChannelVideos("UCabc");
    expect(shelf.getVideos).toHaveBeenCalledOnce();
  });
});

/**
 * The fallback path's latency budget.
 *
 * This block exists because the E2E radio exhaustion journey failed because of
 * it. The transport used to wrap the session handshake in a 12s timeout and
 * then wrap `session().then(search)` in a SECOND 12s timeout, so an unreachable
 * primary cost 24 seconds before the official API was tried — and since a
 * failed handshake cleared its memo slot, every subsequent avenue paid the same
 * 24 seconds again. A radio station asks for two avenues, so a user's request
 * went from one API call to roughly a minute, and the queue sat on "Finding
 * more tracks…" indefinitely.
 *
 * The rule these tests enforce: ONE deadline covers the whole operation
 * including the handshake, and a dead primary is paid for once, not once per
 * caller.
 */
describe("the fallback path's latency budget", () => {
  const REQUEST_MS = 120;
  const SESSION_MS = 60;
  // Generous enough not to flake on a loaded CI box, tight enough that an
  // additive regression (2x, or 3x for the channel path) cannot hide inside it.
  const SLACK_MS = 90;

  function transportWith(
    factory: () => Promise<never>,
  ): ReturnType<typeof createInnerTubeTransport> {
    return createInnerTubeTransport({
      sessionFactory: factory as never,
      searchTtlMs: 60_000,
      videoTtlMs: 60_000,
      requestTimeoutMs: REQUEST_MS,
      sessionTimeoutMs: SESSION_MS,
      sessionFailureTtlMs: 30_000,
    });
  }

  it("bounds a search by ONE deadline, not the handshake plus the request", async () => {
    // The session succeeds quickly; the SEARCH is what hangs. If the two
    // budgets were additive this would take SESSION_MS + REQUEST_MS.
    const transport = createInnerTubeTransport({
      sessionFactory: async () => ({ search: () => new Promise<never>(() => {}) }) as never,
      requestTimeoutMs: REQUEST_MS,
      sessionTimeoutMs: SESSION_MS,
    });
    const started = Date.now();
    await expect(transport.searchVideos("x")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(ms(started)).toBeLessThan(REQUEST_MS + SLACK_MS);
  });

  it("bounds a hung handshake by the handshake budget, not the request budget", async () => {
    const { factory } = hungSessionFactory();
    const started = Date.now();
    await expect(transportWith(factory).searchVideos("x")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(ms(started)).toBeLessThan(SESSION_MS + SLACK_MS);
  });

  it("bounds the artist path by one deadline, not one per await", async () => {
    // This one stacks three awaits — session, `getChannel`, `getVideos` — and
    // was the worst case in the phase at roughly 29 seconds. It is also the
    // avenue a radio station uses, which is why the E2E suite hit it.
    const shelf = {
      contents: [],
      has_videos: true,
      getVideos: () => new Promise<never>(() => {}),
    };
    const transport = createInnerTubeTransport({
      sessionFactory: async () => ({ getChannel: async () => shelf }) as never,
      requestTimeoutMs: REQUEST_MS,
      sessionTimeoutMs: SESSION_MS,
    });
    const started = Date.now();
    await expect(transport.searchChannelVideos("UCabc")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(ms(started)).toBeLessThan(REQUEST_MS + SLACK_MS);
  });

  it("pays for a dead primary ONCE, not once per avenue", async () => {
    // Clearing the memo slot on failure is right — it lets a transient blip
    // recover — but it also means an unreachable host is re-dialled by every
    // caller. The failure window is what stops one network partition from
    // becoming a latency tax on every request in the burst.
    const { factory, attempts } = hungSessionFactory();
    const transport = transportWith(factory);
    await expect(transport.searchVideos("x")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(attempts()).toBe(1);

    // A second, DIFFERENT query — the artist avenue. It must not re-dial.
    const started = Date.now();
    await expect(transport.searchChannelVideos("UCabc")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(attempts()).toBe(1);
    // And it must be immediate: the point is that the user is not made to wait
    // twice for the same known-dead host.
    expect(ms(started)).toBeLessThan(SESSION_MS);
  });

  it("retries the handshake once the failure window has passed", async () => {
    // The window must not be a permanent blacklist. A 30s TTL means a genuine
    // recovery is picked up without a restart and without a deploy.
    const { factory, attempts } = hungSessionFactory();
    const transport = createInnerTubeTransport({
      sessionFactory: factory as never,
      requestTimeoutMs: REQUEST_MS,
      sessionTimeoutMs: SESSION_MS,
      sessionFailureTtlMs: 50,
    });
    await expect(transport.searchVideos("x")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(attempts()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 70));
    await expect(transport.searchVideos("y")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(attempts()).toBe(2);
  });

  it("keeps a 50-item metadata batch from paying the handshake fifty times", async () => {
    // One unavailable video must not sink a batch — and one unavailable HOST
    // must not turn a playlist page into fifty sequential timeouts either. The
    // per-item error isolation and the failure window have to work together.
    const { factory, attempts } = hungSessionFactory();
    const transport = transportWith(factory);
    const started = Date.now();
    const ids = Array.from({ length: 50 }, (_, index) => `id${index}`);
    const result = await transport.getVideos(ids);
    expect(result.items).toHaveLength(0);
    expect(attempts()).toBe(1);
    expect(ms(started)).toBeLessThan(REQUEST_MS + SESSION_MS + SLACK_MS);
  });
});

describe("video metadata", () => {
  it("serves three simultaneous identical requests from one upstream call", async () => {
    // §62: TrackRow, Player and Queue asking for the same video at once.
    const { session, getInfo } = fakeSession();
    const transport = transportFor(session);
    await Promise.all([
      transport.getVideos([VIDEO_ID]),
      transport.getVideos([VIDEO_ID]),
      transport.getVideos([VIDEO_ID]),
    ]);
    expect(getInfo).toHaveBeenCalledOnce();
  });

  it("keeps a video id for hours, not minutes", async () => {
    // §49: a video's title, channel and duration do not change, while a search
    // result does. One global TTL would make one of the two wrong.
    vi.useFakeTimers();
    try {
      const { session, getInfo } = fakeSession();
      const transport = createInnerTubeTransport({
        sessionFactory: async () => session as never,
        searchTtlMs: 5_000,
        videoTtlMs: 6 * 60 * 60_000,
      });
      await transport.getVideos([VIDEO_ID]);
      vi.advanceTimersByTime(60_000);
      await transport.getVideos([VIDEO_ID]);
      expect(getInfo).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a transient empty batch become an hour of 'no videos'", async () => {
    // `getVideos` isolates per-item failures by swallowing them, so a dead
    // session or a partition resolves the whole batch to `[]` - successfully.
    // That value is recorded as a NEGATIVE cache entry, and the negative TTL
    // used to be derived from the 6h positive TTL (`ttl / 6`), i.e. one hour
    // of "these videos do not exist" served from cache with the official API
    // fallback never consulted.
    vi.useFakeTimers();
    try {
      const { session, getInfo } = fakeSession({
        // A player response with no usable metadata normalizes to nothing -
        // the same empty batch a dead session produces.
        getInfo: { basic_info: undefined },
      });
      const transport = createInnerTubeTransport({
        sessionFactory: async () => session as never,
        videoTtlMs: 6 * 60 * 60_000,
      });
      expect((await transport.getVideos([VIDEO_ID])).items).toHaveLength(0);
      // Still cached on the short negative clock: a genuine "no results" must
      // not become a request storm.
      vi.advanceTimersByTime(5_000);
      await transport.getVideos([VIDEO_ID]);
      expect(getInfo).toHaveBeenCalledOnce();

      // But not for an hour. The upstream has recovered; we ask again.
      vi.advanceTimersByTime(20_000);
      await transport.getVideos([VIDEO_ID]);
      expect(getInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours an explicit negative-ttl override for the video cache", async () => {
    vi.useFakeTimers();
    try {
      const { session, getInfo } = fakeSession({
        getInfo: { basic_info: undefined },
      });
      const transport = createInnerTubeTransport({
        sessionFactory: async () => session as never,
        videoTtlMs: 6 * 60 * 60_000,
        videoNegativeTtlMs: 1_000,
      });
      await transport.getVideos([VIDEO_ID]);
      vi.advanceTimersByTime(2_000);
      await transport.getVideos([VIDEO_ID]);
      expect(getInfo).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips one unavailable video without sinking the batch", async () => {
    const getInfo = vi.fn(async (id: string) => {
      if (id === "badbadbadba") {
        throw new Error("Video unavailable");
      }
      return { basic_info: { title: "ok", duration: 10 } };
    });
    const transport = transportFor({ search: vi.fn(), getInfo, getChannel: vi.fn() });
    const response = await transport.getVideos([VIDEO_ID, "badbadbadba"]);
    // The surviving id is still returned. A batch of 50 losing all 50 because
    // one is deleted would break playlist hydration for the whole playlist.
    expect(response.items).toHaveLength(1);
  });

  it("returns an empty result for an empty id list without touching the session", async () => {
    const { session, getInfo } = fakeSession();
    const response = await transportFor(session).getVideos([]);
    expect(response.items).toEqual([]);
    expect(getInfo).not.toHaveBeenCalled();
  });
});

describe("the session is created once and shared (§7)", () => {
  it("memoises an injected factory, not just the default one", async () => {
    // A session per request would mean a new visitor identity and a new set of
    // player scripts for every single call. The default factory is already
    // memoised process-wide; memoising here makes the invariant a property of
    // the transport rather than of the default seam, so an injected factory
    // cannot quietly reintroduce two sessions.
    const factory = vi.fn(async () => fakeSession().session);
    const transport = createInnerTubeTransport({
      sessionFactory: factory as never,
      searchTtlMs: 60_000,
      videoTtlMs: 60_000,
    });
    await transport.searchVideos("a");
    await transport.searchVideos("b");
    await transport.getVideos([VIDEO_ID]);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("shares one session across concurrent first calls", async () => {
    const factory = vi.fn(async () => fakeSession().session);
    const transport = createInnerTubeTransport({
      sessionFactory: factory as never,
      searchTtlMs: 60_000,
      videoTtlMs: 60_000,
    });
    await Promise.all([
      transport.searchVideos("a"),
      transport.searchVideos("b"),
      transport.getVideos([VIDEO_ID]),
    ]);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("retries with a fresh session after the failure window, not immediately", async () => {
    // A rejection is never cached for the life of the transport — one transient
    // create failure must not be permanent. It is also not retried on the very
    // next call, because an unreachable host answered identically a moment ago;
    // the window is what separates "recover soon" from "keep knocking".
    const inner = fakeSession().session;
    let attempts = 0;
    const factory = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("session bootstrap failed");
      }
      return inner;
    });
    const transport = createInnerTubeTransport({
      sessionFactory: factory as never,
      searchTtlMs: 60_000,
      videoTtlMs: 60_000,
      sessionFailureTtlMs: 50,
    });
    await expect(transport.searchVideos("a")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    // Inside the window: refused without re-dialling.
    await expect(transport.searchVideos("b")).rejects.toBeInstanceOf(
      InnerTubeUnavailableError,
    );
    expect(factory).toHaveBeenCalledTimes(1);

    // After it: a fresh attempt, and it succeeds.
    await new Promise((resolve) => setTimeout(resolve, 70));
    await expect(transport.searchVideos("c")).resolves.toBeDefined();
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

/**
 * THE TWO BUGS THAT MADE THIS PHASE SAVE NO QUOTA.
 *
 * Both were found by calling the real library, not by reading it, and both were
 * invisible to the rest of the suite because every fixture was written to match
 * the assumption rather than the response. They are pinned here at the seam
 * where they bit, with the offending library behaviour reproduced.
 */
describe("real youtubei.js response shapes", () => {
  it("survives a `page_contents` getter that throws, and still reads `.results`", async () => {
    // `youtubei.js@18.0.0`, `dist/src/core/mixins/Feed.js`:
    //
    //     get page_contents() {
    //       const tab_content = this.#memo.getType(Tab)?.[0].content;
    //
    // The `?.` guards the INDEX and then dereferences anyway. A search response
    // has no `Tab` node, so merely asking for `page_contents` raises
    // `TypeError: Cannot read properties of undefined (reading 'content')`.
    // Probing that location killed every search in production while the unit
    // tests passed, because no fixture had a throwing getter.
    const results = {
      results: [realVideoRow()],
      get page_contents(): unknown {
        throw new TypeError("Cannot read properties of undefined (reading 'content')");
      },
    };
    const search = vi.fn(async () => results);
    const transport = transportFor({ search });
    const response = await transport.searchVideos("son tung");
    expect(response.items).toHaveLength(1);
    expect(search).toHaveBeenCalledOnce();
  });

  it("asks InnerTube for a TYPED result set", async () => {
    // Measured: an unfiltered `yt.search()` for a music query returns 22 rows
    // including an `OfficialCardView`, a node v18.0.0 has no parser for. With
    // `{ type }` the same query returns only `Video` / `Channel` rows — about
    // half the latency and no un-parseable shelf. The filter is load-bearing,
    // not tidiness.
    const { session, search } = fakeSession();
    const transport = transportFor(session);
    await transport.searchVideos("x");
    expect(search).toHaveBeenCalledWith("x", { type: "video" });
    await transport.searchChannels("y");
    expect(search).toHaveBeenCalledWith("y", { type: "channel" });
  });

  it("reads a channel's videos tab from current_tab, unwrapping RichItem", async () => {
    // Measured: `channel.getVideos()` returns the *Channel object*, not a
    // shelf, and its rows are `RichItem` wrappers at
    // `current_tab.content.contents`. The first implementation looked at
    // `contents` and `page_contents`, found nothing, and returned zero items —
    // so `artists.tracks` always fell back to the official API.
    const shelf = {
      current_tab: { content: { contents: [{ type: "RichItem", content: lockup(VIDEO_ID) }] } },
    };
    const channel = {
      has_videos: true,
      getVideos: vi.fn(async () => shelf),
    };
    const session = {
      search: vi.fn(),
      getInfo: vi.fn(),
      getChannel: vi.fn(async () => channel),
    };
    const transport = transportFor(session);
    const response = await transport.searchChannelVideos("UCabc", { limit: 5 });
    expect(response.items).toHaveLength(1);
    expect((response.items as Array<{ id: { videoId: string } }>)[0]?.id.videoId).toBe(VIDEO_ID);
  });

  it("reads a typed search's `Video` rows, not just `LockupView`s", async () => {
    // The regression in one assertion: with a `Video`-row fixture the adapter
    // produced nothing, the gate read that as a parse failure, and the request
    // went to the official API. Asserting on the request would still have
    // passed, so this asserts on the RESULT.
    const search = vi.fn(async () => ({ results: [realVideoRow(), realChannelRow()] }));
    const transport = transportFor({ search });
    const response = await transport.searchVideos("son tung", { limit: 5 });
    expect(response.items).toHaveLength(1);
    const item = (response.items as Array<{ id: { videoId: string }; snippet: { channelTitle?: string } }>)[0];
    expect(item?.id.videoId).toBe("SlQR9iu09bQ");
    expect(item?.snippet.channelTitle).toBe("Sơn Tùng M-TP Official");
  });

  it("reads a typed search's `Channel` rows", async () => {
    const search = vi.fn(async () => ({ results: [realChannelRow()] }));
    const transport = transportFor({ search });
    const response = await transport.searchChannels("son tung", { limit: 5 });
    expect(response.items).toHaveLength(1);
    const item = (response.items as Array<{ id: { channelId: string }; snippet: { title: string } }>)[0];
    expect(item?.id.channelId).toBe("UClyA28-01x4z60eWQ2kiNbA");
    expect(item?.snippet.title).toBe("Sơn Tùng M-TP Official");
  });

  it("hydrates a video whose getInfo author is a bare string", async () => {
    // The read that returned null and dropped channel + artwork from every
    // hydrated track, with no error anywhere to show for it.
    const getInfo = vi.fn(async () => ({
      basic_info: {
        id: VIDEO_ID,
        channel_id: "UClyA28-01x4z60eWQ2kiNbA",
        title: "COME MY WAY",
        duration: 235,
        author: "Sơn Tùng M-TP Official",
        is_live_content: false,
        is_upcoming: false,
        thumbnail: [{ url: "https://i.ytimg.com/vi/x/maxres.jpg", width: 1280, height: 720 }],
      },
    }));
    const transport = transportFor({ search: vi.fn(), getInfo, getChannel: vi.fn() });
    const response = await transport.getVideos([VIDEO_ID]);
    const item = (response.items as Array<{ snippet: { channelTitle?: string; channelId?: string; thumbnails?: unknown } }>)[0];
    expect(item?.snippet.channelTitle).toBe("Sơn Tùng M-TP Official");
    expect(item?.snippet.channelId).toBe("UClyA28-01x4z60eWQ2kiNbA");
    expect(item?.snippet.thumbnails).toBeDefined();
  });
});
