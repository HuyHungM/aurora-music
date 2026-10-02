import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * Search by provider link (SEARCH BY SPOTIFY / YOUTUBE LINK).
 *
 * One input, three outcomes. The classification half of this file runs
 * unconditionally: detection is a pure string comparison, a refused link is
 * refused without a provider call, and ordinary prose still searches. None of
 * that needs credentials or a network beyond Aurora itself, so it is part of
 * the default suite rather than behind the live gate.
 *
 * The four numbered flows below are the resolution half and are opt-in for
 * the same reason `live-search.spec.ts` is: they spend real provider quota,
 * so provider availability — not Aurora's own behaviour — decides whether
 * they can run. The gates read the spec process environment, mirroring that
 * spec exactly (the server resolves its own keys from `.env`).
 *
 * What every assertion here has in common: nothing is checked against a
 * private flag. The pill, the refusal copy, the eyebrow on a resolved card
 * and the rows of a resolved collection are all things a screen-reader user
 * is told, so they are what the test is told too.
 */
const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";
// Metadata lookups need the key on BOTH sides (spec process for the gate,
// server process for the result — the server inherits env).
const YOUTUBE_LIVE = LIVE && !!process.env.YOUTUBE_API_KEY;
const SPOTIFY_LIVE =
  YOUTUBE_LIVE && !!process.env.SPOTIFY_CLIENT_ID && !!process.env.SPOTIFY_CLIENT_SECRET;

/** Verified real resources; a stale id would make a flow fail for the wrong reason. */
const YOUTUBE_VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const YOUTUBE_SHORT = "https://youtu.be/dQw4w9WgXcQ";
const SPOTIFY_TRACK = "https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8";
const SPOTIFY_PLAYLIST =
  "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M";
/** An allowlisted host with a resource type this build cannot read. */
const SPOTIFY_ARTIST = "https://open.spotify.com/artist/6Ub0qfYbXNoUvufHmuvafC";
/** Not an allowlisted host: must never reach a provider as text or as a link. */
const FOREIGN = "https://example.com/watch?v=dQw4w9WgXcQ";
/** Over the 200-character prose cap on purpose: classification runs first. */
const LONG_URL = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${"PL".repeat(120)}`;

const PAGE_SEARCH = "#search-q";

/** The page's own field, scoped to the page landmark (see `search-navigation.spec.ts`). */
function pageField(page: Page) {
  return page.getByRole("main").locator(PAGE_SEARCH);
}

/**
 * The live region inside the page's search form.
 *
 * Scoped to `role="search"` rather than to `<main>`: two search fields are on
 * screen at every width, and only the page variant owns this region.
 */
function indicator(page: Page) {
  return page.getByRole("main").getByRole("search").getByRole("status");
}

/** The page's single top-level heading. */
function h1(page: Page) {
  return page.getByRole("main").getByRole("heading", { level: 1 });
}

/** The region a resolved track is rendered into (`search.linkResultSection`). */
function linkRegion(page: Page) {
  return page.getByRole("region", { name: "Detected link" });
}

/** Quoted the way `search.resultsFor` renders it; quote style may drift. */
function resultsHeading(page: Page, query: string) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("main").getByRole("heading", {
    level: 1,
    name: new RegExp(`Results for [“"]${escaped}[”"]`, "i"),
  });
}

/** Every action-menu label in scope, in DOM order. */
async function actionLabels(scope: Locator): Promise<string[]> {
  return scope.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("aria-label") ?? ""),
  );
}

test.describe("search input: link detection and refusal", () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    // Unauthenticated surfaces have no user preference, so `getRequestLocale`
    // would otherwise fall back to `vi` and every English assertion below
    // would be testing the wrong surface.
    await context.addCookies([
      {
        name: "aurora-locale",
        value: "en",
        url: baseURL ?? "http://127.0.0.1:3100",
      },
    ]);

    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    (page as Page & { __errors?: string[] }).__errors = errors;
  });

  test.afterEach(async ({ page }) => {
    const errors = (page as Page & { __errors?: string[] }).__errors ?? [];
    // Classifying on every keystroke is new render-path work in the field; a
    // hydration mismatch there would be invisible until it desynced the pill
    // from the input.
    expect(
      errors.filter((e) => /hydrat|did not match|Warning:/i.test(e)),
      `console errors: ${errors.join(" | ")}`,
    ).toEqual([]);
  });

  test("1. a supported link announces itself without navigating", async ({
    page,
  }) => {
    await page.goto("/search");

    await pageField(page).fill(YOUTUBE_VIDEO);
    await expect(indicator(page)).toHaveText("YouTube link detected");

    await pageField(page).fill(SPOTIFY_TRACK);
    await expect(indicator(page)).toHaveText("Spotify link detected");

    // Detection is a hint, not a second search: nothing was submitted, so the
    // URL has no query and no provider was asked anything.
    expect(page.url()).not.toContain("q=");
    await expect(h1(page)).not.toContainText("Results for");
  });

  test("2. ordinary text and unreadable links are not flagged", async ({
    page,
  }) => {
    await page.goto("/search");

    await pageField(page).fill("Sơn Tùng M-TP");
    await expect(indicator(page)).toHaveText("");

    // An artist page is a real link on a real allowlisted host, but this build
    // does not resolve it. Promising otherwise here and then refusing on submit
    // would be the field lying about what pressing Enter will do.
    await pageField(page).fill(SPOTIFY_ARTIST);
    await expect(indicator(page)).toHaveText("");

    await pageField(page).fill("listen to https://youtu.be/dQw4w9WgXcQ later");
    await expect(indicator(page)).toHaveText("");
  });

  test("3. a foreign host is refused with copy, not searched", async ({
    page,
  }) => {
    await page.goto(`/search?q=${encodeURIComponent(FOREIGN)}`);

    await expect(h1(page)).toHaveText("Unsupported link");
    await expect(
      page.getByText(
        "This link type isn't supported. Try a Spotify or YouTube link.",
        { exact: true },
      ),
    ).toBeVisible();

    // The three things that must NOT be here: a provider result section, a
    // text-search heading for URL prose, and a spinner that replaced the page.
    await expect(page.getByRole("region", { name: "Tracks" })).toHaveCount(0);
    await expect(h1(page)).not.toContainText("Results for");
    await expect(pageField(page)).toBeVisible();
    await expect(pageField(page)).toHaveValue(FOREIGN);
  });

  test("4. an allowlisted host with an unreadable resource says so precisely", async ({
    page,
  }) => {
    await page.goto(`/search?q=${encodeURIComponent(SPOTIFY_ARTIST)}`);

    await expect(h1(page)).toHaveText("Unsupported link");
    await expect(
      page.getByText(
        "Aurora reads Spotify, YouTube and Deezer track, album and playlist links.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Tracks" })).toHaveCount(0);
  });

  test("5. a link past the prose cap still classifies as a link", async ({
    page,
  }) => {
    expect(LONG_URL.length).toBeGreaterThan(200);

    await page.goto(`/search?q=${encodeURIComponent(LONG_URL)}`);

    // `searchQuerySchema` caps `q` at 200 characters. Had validation run
    // first, this would be an "query too long" error rather than a link.
    await expect(h1(page)).not.toContainText("too long");
    await expect(h1(page)).not.toContainText("Results for");
    await expect(indicator(page)).toHaveText("YouTube link detected");
  });

  test("6. punctuated prose keeps behaving like a search", async ({ page }) => {
    await page.goto(`/search?q=${encodeURIComponent("What's up?")}`);

    await expect(resultsHeading(page, "What's up?")).toBeVisible({
      timeout: 30_000,
    });
    await expect(h1(page)).not.toContainText("Unsupported link");
  });

  test("7. Enter submits a pasted link through the shared form path", async ({
    page,
  }) => {
    await page.goto("/search");
    await pageField(page).fill(YOUTUBE_SHORT);
    await expect(indicator(page)).toHaveText("YouTube link detected");

    await pageField(page).press("Enter");

    await expect(page).toHaveURL(/\/search\?q=/);
    expect(new URL(page.url()).searchParams.get("q")).toBe(YOUTUBE_SHORT);
  });

  test("8. the field is selectable and its controls are pointers", async ({
    page,
  }) => {
    await page.goto("/search");
    const field = pageField(page);
    await field.fill(YOUTUBE_VIDEO);

    // The query has to be copyable (it is the thing a user pastes and then
    // wants back), and the controls beside it have to read as controls.
    const inputStyle = await field.evaluate((el) => {
      const style = getComputedStyle(el);
      return { cursor: style.cursor, userSelect: style.userSelect };
    });
    expect(inputStyle.cursor).toBe("text");
    expect(inputStyle.userSelect).toBe("text");

    const clear = page
      .getByRole("main")
      .getByRole("button", { name: "Clear search" });
    const clearStyle = await clear.evaluate((el) => {
      const style = getComputedStyle(el);
      return { cursor: style.cursor, userSelect: style.userSelect };
    });
    expect(clearStyle.cursor).toBe("pointer");
    expect(clearStyle.userSelect).toBe("none");
  });

  test("9. detection and the field work at a phone width", async ({ page }) => {
    // Desktop and mobile are the same input with the same classifier; this
    // asserts the page variant (the only one that shows the hint) does not
    // depend on a desktop-only layout.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/search");

    await pageField(page).fill(YOUTUBE_VIDEO);
    await expect(pageField(page)).toBeVisible();
    await expect(indicator(page)).toHaveText("YouTube link detected");

    await pageField(page).fill(SPOTIFY_TRACK);
    await expect(indicator(page)).toHaveText("Spotify link detected");
  });
});

test.describe("search link resolution (live providers)", () => {
  test.skip(
    !YOUTUBE_LIVE,
    "Requires AURORA_E2E_LIVE_PLAYBACK=1 and YOUTUBE_API_KEY.",
  );

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([
      {
        name: "aurora-locale",
        value: "en",
        url: baseURL ?? "http://127.0.0.1:3100",
      },
    ]);
  });

  test("flow 1 — a YouTube video link resolves to that video and plays", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.goto(`/search?q=${encodeURIComponent(YOUTUBE_VIDEO)}`);

    const region = linkRegion(page);
    await expect(region).toBeVisible({ timeout: 60_000 });
    await expect(region.getByText("YouTube · Track", { exact: true })).toBeVisible();
    // One track, not a list: the id was already known, so there was nothing to
    // rediscover and no search results section to show.
    await expect(h1(page)).not.toContainText("Results for");

    await region.getByRole("button", { name: /^Play / }).first().click();
    await expect(page.getByRole("button", { name: /^Pause / }).first()).toBeVisible({
      timeout: 60_000,
    });
    // UI-LEVEL evidence, and the strongest available on this route. This test
    // drives `/search`, which does not mount the media probe, so it cannot read
    // `currentTime`; media-level proof lives in `live-playback.spec.ts`.
    // The seek slider this used to poll is exactly the selector whose absence
    // produced the "NOT_PLAYING" misdiagnosis, so it is not a playback oracle.
  });

  test("flow 2 — ignored tracking parameters do not change what resolves", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.goto(`/search?q=${encodeURIComponent(YOUTUBE_VIDEO)}`);
    await expect(linkRegion(page)).toBeVisible({ timeout: 60_000 });
    const canonicalTitle = (await h1(page).textContent())?.trim();
    expect(canonicalTitle).toBeTruthy();

    const noisy = `${YOUTUBE_SHORT}?si=trackingNoise&t=42&feature=share`;
    await page.goto(`/search?q=${encodeURIComponent(noisy)}`);

    await expect(linkRegion(page)).toBeVisible({ timeout: 60_000 });
    await expect(h1(page)).toHaveText(canonicalTitle as string);
    // The field keeps what was pasted — identity, not input, is what got
    // normalised.
    await expect(pageField(page)).toHaveValue(noisy);
    // And nothing was recorded against the tracking parameters.
    await expect(h1(page)).not.toContainText("Results for");
  });

  test("flow 3 — a Spotify track link resolves through metadata", async ({
    page,
  }) => {
    test.skip(
      !SPOTIFY_LIVE,
      "Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.",
    );
    test.setTimeout(150_000);
    await page.goto(`/search?q=${encodeURIComponent(SPOTIFY_TRACK)}`);

    const region = linkRegion(page);
    await expect(region).toBeVisible({ timeout: 60_000 });
    await expect(region.getByText("Spotify · Track", { exact: true })).toBeVisible();
    // Spotify supplies metadata only: this is a single resolved card, never a
    // text search of the pasted URL and never a stream handed to the browser.
    await expect(h1(page)).not.toContainText("Results for");

    // Whether a YouTube equivalent was found decides Play — it never decides
    // whether the result exists. Both are correct outcomes of the existing
    // matcher, and third-party metadata decides which one applies today.
    const play = region.getByRole("button", { name: /^Play / }).first();
    if (await play.isVisible()) {
      await play.click();
      await expect(page.getByRole("button", { name: /^Pause / }).first()).toBeVisible({
        timeout: 60_000,
      });
    } else {
      const unavailable = region
        .getByRole("button", { name: /^Playback unavailable/ })
        .first();
      await expect(unavailable).toBeVisible();
      await expect(unavailable).toBeDisabled();
    }

    // Provider-agnostic actions are present either way.
    await expect(
      region.getByRole("button", { name: /^Actions for / }),
    ).toBeVisible();
  });

  test("flow 4 — a Spotify playlist link loads a bounded, deduped collection", async ({
    page,
  }) => {
    test.skip(
      !SPOTIFY_LIVE,
      "Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.",
    );
    test.setTimeout(180_000);
    await page.goto(`/search?q=${encodeURIComponent(SPOTIFY_PLAYLIST)}`);

    const region = page.getByRole("region", { name: "Spotify · Playlist" });
    await expect(region).toBeVisible({ timeout: 60_000 });
    await expect(region.getByRole("heading", { level: 2 })).toHaveText(
      /Top Hits/,
    );

    // Bounded load: the header states how many rows it actually holds, and
    // how many the provider has when it held fewer.
    const meta = (await region.locator("span.t-metadata").first().textContent()) ?? "";
    const shown = Number(/(\d+) tracks/.exec(meta)?.[1] ?? "0");
    const total = /of (\d+) tracks/.exec(meta)?.[1];
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(20);
    if (total) expect(Number(total)).toBeGreaterThan(shown);

    // Numbered playlist rows, one menu each.
    const rows = region.locator("li");
    await expect(rows).toHaveCount(shown);
    await expect(rows.first().locator("span.tabular-nums").first()).toHaveText("1");

    // CROSS-SOURCE DEDUPE: two catalogue entries that matched the same video
    // are one logical track and must not both survive. Each surviving row is
    // identified by its action-menu label, which carries the title, so a
    // repeat here would be a duplicate canonical identity.
    const rowLabels = await actionLabels(
      region.getByRole("button", { name: /^Actions for / }),
    );
    expect(rowLabels).toHaveLength(shown);
    expect(new Set(rowLabels).size).toBe(shown);

    // Queuing goes through the existing add path: exactly one entry per row,
    // checked before anything can start playback and move a row into
    // "Now playing" (which would make the expected count depend on whether a
    // cross-source match was found today).
    await region.getByRole("button", { name: "Add all to queue" }).click();
    const queue = page.getByRole("dialog", { name: "Queue" });
    await page
      .getByRole("region", { name: "Player bar" })
      .getByRole("button", { name: "Up next" })
      .click();
    await expect(queue).toBeVisible();
    await expect(
      queue.getByRole("region", { name: "Next up" }).locator("li"),
    ).toHaveCount(shown);
    // Focus is moved into the panel on open (see `queue-panel.test.tsx`), so
    // Escape is the same dismissal path a keyboard user has.
    await page.keyboard.press("Escape");
    await expect(queue).toHaveCount(0);

    // Play all follows `trackCapabilities`: enabled exactly when at least one
    // row is playable, and starting there rather than on a dead head row.
    const playableRows = await rows.getByRole("button", { name: /^Play / }).count();
    const playAll = region.getByRole("button", { name: "Play all" });
    if (playableRows > 0) {
      await expect(playAll).toBeEnabled();
      await playAll.click();
      await expect(
        page.getByRole("button", { name: /^Pause / }).first(),
      ).toBeVisible({ timeout: 60_000 });
    } else {
      await expect(playAll).toBeDisabled();
    }
  });
});
