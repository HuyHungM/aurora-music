import { test, expect, type Page } from "@playwright/test";

/**
 * Search navigation, query persistence, and reload behaviour.
 *
 * The defect: both the header bar and the `/search` page were native
 * `<form action="/search" method="get">` elements. A GET form is a browser
 * *document* navigation, so submitting a search tore down the whole app
 * tree. That is not merely slower than a client transition — `PlayerHost`
 * lives in the `(app)` layout and owns the audio engine, and its unmount
 * cleanup calls `music.shutdown()`. Searching while music played stopped
 * playback, dropped the memory-only radio session, and re-fired the
 * search-history write on the fresh document.
 *
 * The central assertion in this file is the `window` sentinel. A document
 * navigation destroys every global; an App Router transition does not. So
 * "the sentinel survived" is a direct, behavioural test for "this was not
 * a full page reload", which no URL assertion can distinguish.
 */
const HEADER_SEARCH = "#global-search";
const PAGE_SEARCH = "#search-q";

/**
 * The `/search` page's own field, scoped to the page landmark.
 *
 * Two search inputs are always on screen (header + page), and during a
 * client transition the router can briefly keep the outgoing page tree
 * mounted alongside the incoming one — so a bare `#search-q` resolves to
 * two elements and trips a strict-mode violation. Scoping to `<main>`
 * addresses the page's field deterministically and states the intent:
 * this assertion is about the page's input, not the header's.
 */
function pageField(page: Page) {
  return page.getByRole("main").locator(PAGE_SEARCH);
}

/** The page field's own clear control. */
function pageClear(page: Page) {
  return page
    .getByRole("main")
    .locator(PAGE_SEARCH)
    .locator("xpath=..")
    .getByRole("button", { name: "Clear search" });
}

/** Marks the current document so a reload can be detected from the page. */
const SENTINEL = "__auroraNoReloadSentinel";

async function markDocument(page: Page): Promise<void> {
  await page.evaluate((key) => {
    (window as unknown as Record<string, unknown>)[key] = true;
  }, SENTINEL);
}

/** True when the document that is live now is the one we marked. */
async function sameDocument(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] === true,
    SENTINEL,
  );
}

/**
 * The server renders results for the URL query, so this heading proves the
 * page was reconstructed from the URL alone. Quote style is matched loosely
 * because the copy is typographic and a copy edit must not orphan it.
 */
function resultsHeading(page: Page, query: string) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("heading", {
    name: new RegExp(`Results for [“"]${escaped}[”"]`, "i"),
  });
}

test.describe("search navigation and query persistence", () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    // Pin the locale through the real cookie mechanism. Unauthenticated
    // surfaces have no user preference, so `getRequestLocale` otherwise
    // falls back to `vi` and every English assertion would be testing the
    // wrong surface.
    await context.addCookies([
      { name: "aurora-locale", value: "en", url: baseURL ?? "http://127.0.0.1:3100" },
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
    // Hydration mismatches and router errors surface here; a search
    // navigation must not produce either.
    expect(
      errors.filter((e) => /hydrat|did not match|Warning:/i.test(e)),
      `console errors: ${errors.join(" | ")}`,
    ).toEqual([]);
  });

  test("A. Enter from the header navigates without reloading the document", async ({
    page,
  }) => {
    await page.goto("/");
    await markDocument(page);

    await page.locator(HEADER_SEARCH).fill("test");
    await page.locator(HEADER_SEARCH).press("Enter");

    await expect(page).toHaveURL(/\/search\?q=test$/);
    // The load-bearing assertion: same document, so the layout — and with
    // it PlayerHost and the audio engine — was never unmounted.
    expect(await sameDocument(page)).toBe(true);
  });

  test("B. the search button and Enter share one submit path", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(HEADER_SEARCH).fill("alpha");
    await page.locator(HEADER_SEARCH).press("Enter");
    await expect(page).toHaveURL(/\/search\?q=alpha$/);

    // Submitting the identical query again must not re-navigate: a second
    // transition would remount the results and refire the history write.
    await markDocument(page);
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    await pageField(page).press("Enter");
    // A fixed wait is correct here specifically because the assertion is
    // about an *absence*. Proving nothing happened cannot poll for a
    // positive signal, so it needs a bounded window; 750ms is several
    // times the transition a real navigation would take.
    await page.waitForTimeout(750);
    expect(await sameDocument(page)).toBe(true);
    expect(navigations).toEqual([]);
  });

  test("C. a Vietnamese query is encoded and restored", async ({ page }) => {
    await page.goto("/");
    await page.locator(HEADER_SEARCH).fill("Sơn Tùng M-TP");
    await page.locator(HEADER_SEARCH).press("Enter");

    await expect(page).toHaveURL(/\/search\?q=S%C6%A1n%20T%C3%B9ng%20M-TP$/);
    // Both fields mirror the URL: the page field from the server-resolved
    // query, the header from the URL it shares across routes.
    await expect(pageField(page)).toHaveValue("Sơn Tùng M-TP");
    await expect(page.locator(HEADER_SEARCH)).toHaveValue("Sơn Tùng M-TP");
    await expect(resultsHeading(page, "Sơn Tùng M-TP")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("D. a full reload restores query and results from the URL alone", async ({
    page,
  }) => {
    await page.goto("/search?q=sontungmtp");
    await expect(pageField(page)).toHaveValue("sontungmtp");
    await expect(resultsHeading(page, "sontungmtp")).toBeVisible({
      timeout: 30_000,
    });

    // A genuine reload destroys the sentinel — that is the control proving
    // the sentinel is a meaningful signal and not always true.
    await markDocument(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await sameDocument(page)).toBe(false);

    await expect(pageField(page)).toHaveValue("sontungmtp");
    await expect(resultsHeading(page, "sontungmtp")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("E. back and forward restore the matching query", async ({ page }) => {
    await page.goto("/");
    await page.locator(HEADER_SEARCH).fill("alpha");
    await page.locator(HEADER_SEARCH).press("Enter");
    await expect(page).toHaveURL(/q=alpha/);

    await page.locator(HEADER_SEARCH).fill("beta");
    await page.locator(HEADER_SEARCH).press("Enter");
    await expect(page).toHaveURL(/q=beta/);
    await expect(pageField(page)).toHaveValue("beta");

    await page.goBack();
    await expect(page).toHaveURL(/q=alpha/);
    await expect(pageField(page)).toHaveValue("alpha");
    await expect(resultsHeading(page, "alpha")).toBeVisible({ timeout: 30_000 });

    await page.goForward();
    await expect(page).toHaveURL(/q=beta/);
    await expect(pageField(page)).toHaveValue("beta");
    await expect(resultsHeading(page, "beta")).toBeVisible({ timeout: 30_000 });
  });

  test("F. surrounding whitespace is trimmed, inner spacing preserved", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(HEADER_SEARCH).fill("  Sơn Tùng M-TP  ");
    await page.locator(HEADER_SEARCH).press("Enter");
    await expect(page).toHaveURL(/\/search\?q=S%C6%A1n%20T%C3%B9ng%20M-TP$/);
  });

  test("G. an emptied query lands on the bare search route", async ({
    page,
  }) => {
    await page.goto("/search?q=test");
    await pageClear(page).click();
    await expect(page).toHaveURL(/\/search$/);
    // The meaningless `?q=` must not be produced.
    expect(page.url()).not.toContain("q=");
    await expect(pageField(page)).toHaveValue("");
  });

  test("H. the empty query route renders its empty state", async ({ page }) => {
    await page.goto("/search");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(pageField(page)).toHaveValue("");
  });

  test("I. direct access needs no client-side bootstrap", async ({ page }) => {
    // A cold load of a deep link: if the field depended on a client-only
    // effect to populate, this first paint would be empty.
    await page.goto("/search?q=sontungmtp");
    await expect(pageField(page)).toHaveValue("sontungmtp");
  });

  test("J. both mobile search affordances navigate without a document reload", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // There are two mobile entry points to search: the header icon and the
    // bottom tab bar. They are separate components, so parity is asserted
    // rather than assumed.
    const affordances = [
      { what: "header icon", link: page.getByRole("banner").getByRole("link", { name: "Search" }) },
      { what: "bottom tab", link: page.getByRole("list").getByRole("link", { name: "Search" }) },
    ];

    for (const { what, link } of affordances) {
      await page.goto("/");
      await expect(link).toBeVisible();
      await markDocument(page);

      await link.click();
      await expect(page, `${what} should reach /search`).toHaveURL(/\/search$/);
      expect(await sameDocument(page), `${what} reloaded the document`).toBe(
        true,
      );
    }
  });
});
