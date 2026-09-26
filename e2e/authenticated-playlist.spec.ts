/**
 * Authenticated playlist journeys (Phase 30). Real browser, real
 * Auth.js session cookie, real server actions → requireUser → DAL →
 * test DB. No OAuth, no providers, no mocks.
 *
 * Each test is self-sufficient: it creates its own playlist through
 * the real library UI, so no test depends on another test's state.
 * Teardown wipes all synthetic rows and asserts zero leftovers.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";
import { dbPlaylistTrackTitles } from "./auth/run";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_TWO = FIXTURE_TRACKS[1].title;

/**
 * A playlist title unique to this worker process.
 *
 * Playlist titles are NOT unique in the schema, and `cleanupAuthTestData`
 * removes them by deleting the owning user, which happens at suite teardown
 * rather than between tests. So a fixed title is only safe while nothing
 * outside the current run can already hold it.
 *
 * MEASURED, not assumed: polling the database while this spec ran under
 * `--repeat-each=3` showed the row count for a fixed title climbing 1 -> 2 -> 3
 * and never resetting, and the second iteration then failed on a
 * strict-mode violation because the library page rendered every accumulated
 * card. Monotonic growth across iterations is leftover state; a double-submit
 * would jump and plateau inside a single iteration. The fix is isolation, not
 * a looser locator - the assertions stay exactly as strict as they were.
 *
 * `process.pid` plus a monotonic counter is enough: it is unique per worker
 * process and per call, needs no clock, and keeps runs reproducible enough to
 * debug because the prefix stays human-readable.
 */
let titleSequence = 0;
function uniqueTitle(prefix: string): string {
  titleSequence += 1;
  return `${prefix} ${process.pid}-${titleSequence}`;
}

async function createPlaylistViaUI(
  page: import("@playwright/test").Page,
  title: string,
): Promise<string> {
  await page.goto("/library");
  await expect(
    page.getByRole("heading", { name: "Your Library" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create playlist" })
    .first()
    .click();
  await page.getByLabel("Name").fill(title);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForURL(/\/library\/playlists\/.+/);
  await expect(
    page.getByRole("heading", { name: title }),
  ).toBeVisible({ timeout: 15_000 });
  return page.url().split("/library/playlists/")[1].split("?")[0];
}

async function addFixtureTrackViaUI(
  page: import("@playwright/test").Page,
  trackTitle: string,
  playlistTitle: string,
): Promise<void> {
  await page.goto("/e2e-library");
  await expect(
    page.getByRole("heading", { name: "E2E fixture library" }),
  ).toBeVisible();
  await page.getByRole("button", { name: `Actions for ${trackTitle}` }).click();
  await page.getByRole("menuitem", { name: "Add to playlist" }).click();
  const submenu = page.getByRole("menu", { name: "Add to playlist" });
  await expect(submenu).toBeVisible();
  await submenu.getByRole("menuitem", { name: new RegExp(playlistTitle) }).click();
  // Success is shown inline before the menu auto-closes; the durable
  // proof is the playlist page itself.
  await expect(submenu).toHaveCount(0, { timeout: 15_000 });
}

async function orderOnDetailPage(
  page: import("@playwright/test").Page,
): Promise<{ one: number; two: number }> {
  const html = await page.locator("main").innerHTML();
  return { one: html.indexOf(TRACK_ONE), two: html.indexOf(TRACK_TWO) };
}

authTest.describe("authenticated playlist journeys", () => {
  authTest("Journey 1: create playlist appears and opens", async ({ pageA }) => {
    const title = uniqueTitle("E2E Create");
    const playlistId = await createPlaylistViaUI(pageA, title);
    expect(playlistId.length).toBeGreaterThan(0);

    // Re-enter through the library: the new playlist card is listed.
    //
    // ROOT CAUSE of the historical strict-mode violations here, established
    // from the page snapshot Playwright captured at failure: the page was NOT
    // `/library`. It was still the playlist DETAIL page, which renders the
    // playlist title in more than one `span.t-card-title`, so a document-wide
    // `getByText` matched twice; and scoping to `#playlists` then found nothing
    // at all, because the library section was not on the page.
    //
    // Why: creating a playlist is a server action that navigates the app
    // router to the new playlist. `goto("/library")` issues a document
    // navigation, but the router's own pending navigation lands afterwards, so
    // the run ends up on the detail page. The bug is missing synchronisation,
    // not a bad selector.
    //
    // So the library page is asserted as a page before anything inside it is
    // asserted, which is what turns a silent wrong-page assertion into an
    // explicit failure. `createPlaylistViaUI` already does this for its own
    // first step; this is the same guard on the way back.
    await pageA.goto("/library");
    await expect(pageA.getByRole("heading", { name: "Your Library" })).toBeVisible({
      timeout: 15_000,
    });
    //
    // The card, scoped to the library's playlist list. Scoping is strictly more
    // specific than a document-wide substring match, and the title itself is not
    // translated, so the locator works in both locales.
    //
    // A role-based locator on the card's accessible name was tried here and
    // rejected on evidence: the name is locale-dependent, and assuming the
    // English wording cost 18 of 20 runs.
    const card = pageA.locator("#playlists").getByText(title).first();
    await expect(card).toBeVisible();
    await card.click();
    await pageA.waitForURL(`/library/playlists/${playlistId}`);
    await expect(
      pageA.getByRole("heading", { name: title }),
    ).toBeVisible();
    await expect(pageA.getByText("This playlist is empty")).toBeVisible();
  });

  authTest("Journey 2: add track persists across reload", async ({ pageA }) => {
    const title = uniqueTitle("E2E Add");
    const playlistId = await createPlaylistViaUI(pageA, title);
    await addFixtureTrackViaUI(pageA, TRACK_ONE, title);

    await pageA.goto(`/library/playlists/${playlistId}`);
    await expect(pageA.getByText(TRACK_ONE)).toBeVisible({ timeout: 15_000 });

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(
      pageA.getByRole("heading", { name: title }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByText(TRACK_ONE)).toBeVisible();

    expect(dbPlaylistTrackTitles(playlistId)).toEqual([TRACK_ONE]);
  });

  authTest("Journey 3: duplicate add surfaces the intended conflict", async ({
    pageA,
  }) => {
    const title = uniqueTitle("E2E Duplicate");
    const playlistId = await createPlaylistViaUI(pageA, title);
    await addFixtureTrackViaUI(pageA, TRACK_ONE, title);

    // Add the same track again: membership is known up front, so the
    // row renders disabled in its "already added" state — the duplicate
    // can no longer even be submitted, and no second membership exists.
    // (True races still hit the authoritative backend conflict, covered
    // by DAL + action unit tests.)
    await pageA.goto("/e2e-library");
    await pageA.getByRole("button", { name: `Actions for ${TRACK_ONE}` }).click();
    await pageA.getByRole("menuitem", { name: "Add to playlist" }).click();
    const submenu = pageA.getByRole("menu", { name: "Add to playlist" });
    await expect(submenu).toBeVisible();
    const memberRow = submenu.getByRole("menuitem", {
      name: `${title}, already in playlist`,
    });
    await expect(memberRow).toBeVisible({ timeout: 15_000 });
    expect(await memberRow.isDisabled()).toBe(true);

    expect(dbPlaylistTrackTitles(playlistId)).toEqual([TRACK_ONE]);
  });

  authTest("Journey 4: reorder persists across reload", async ({ pageA }) => {
    const title = uniqueTitle("E2E Reorder");
    const playlistId = await createPlaylistViaUI(pageA, title);
    await addFixtureTrackViaUI(pageA, TRACK_ONE, title);
    await addFixtureTrackViaUI(pageA, TRACK_TWO, title);

    await pageA.goto(`/library/playlists/${playlistId}`);
    await expect(
      pageA
        .getByRole("region", { name: "Playlist tracks" })
        .getByText(TRACK_TWO),
    ).toBeVisible({ timeout: 15_000 });
    let order = await orderOnDetailPage(pageA);
    expect(order.one).toBeLessThan(order.two);

    await pageA
      .getByRole("button", { name: "Move track down" })
      .first()
      .click();
    await expect(async () => {
      order = await orderOnDetailPage(pageA);
      expect(order.two).toBeLessThan(order.one);
    }).toPass({ timeout: 30_000 });

    await pageA.reload({ waitUntil: "domcontentloaded" });
    // Scoped to the playlist's own track list, not a bare `getByText`. After a
    // reload the same title can legitimately appear in more than one place - the
    // mini player carries the current track's title too - and a document-wide
    // text match then resolves to several elements and fails as a strict-mode
    // violation. That is a selector defect, not a product defect, and the order
    // assertion two lines below is the real check.
    await expect(
      pageA.getByRole("region", { name: "Playlist tracks" }).getByText(TRACK_TWO),
    ).toBeVisible({ timeout: 30_000 });
    order = await orderOnDetailPage(pageA);
    expect(order.two).toBeLessThan(order.one);

    expect(dbPlaylistTrackTitles(playlistId)).toEqual([
      TRACK_TWO,
      TRACK_ONE,
    ]);
  });

  authTest("Journey 9: create-from-picker auto-adds the track", async ({
    pageA,
  }) => {
    const title = uniqueTitle("E2E Picker Create");
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();
    await pageA.getByRole("button", { name: `Actions for ${TRACK_TWO}` }).click();
    await pageA.getByRole("menuitem", { name: "Add to playlist" }).click();
    const submenu = pageA.getByRole("menu", { name: "Add to playlist" });
    await expect(submenu).toBeVisible();
    await submenu.getByRole("menuitem", { name: "Create new playlist" }).click();

    // The create dialog stays in context (no navigation away).
    await pageA.getByLabel("Name").fill(title);
    await pageA.getByRole("button", { name: "Create", exact: true }).click();
    // Auto-add succeeds against the brand-new playlist.
    await expect(
      submenu.getByRole("menuitem", { name: `${title}, already in playlist` }),
    ).toBeVisible({ timeout: 15_000 });

    // Assert the library page as a page before anything inside it, for the same
    // measured reason as Journey 1: a pending app-router navigation can land
    // after this `goto` and leave the detail page in place.
    await pageA.goto("/library");
    await expect(pageA.getByRole("heading", { name: "Your Library" })).toBeVisible({
      timeout: 15_000,
    });
    const card = pageA.locator("#playlists").getByText(title).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();
    await pageA.waitForURL(/\/library\/playlists\/.+/);
    await expect(pageA.getByText(TRACK_TWO)).toBeVisible({ timeout: 15_000 });
    const playlistId = pageA.url().split("/library/playlists/")[1].split("?")[0];
    expect(dbPlaylistTrackTitles(playlistId)).toEqual([TRACK_TWO]);
  });

  authTest("Journey 5: remove stays absent across reload", async ({ pageA }) => {
    const title = uniqueTitle("E2E Remove");
    const playlistId = await createPlaylistViaUI(pageA, title);
    await addFixtureTrackViaUI(pageA, TRACK_ONE, title);
    await addFixtureTrackViaUI(pageA, TRACK_TWO, title);

    await pageA.goto(`/library/playlists/${playlistId}`);
    await expect(pageA.getByText(TRACK_ONE)).toBeVisible({ timeout: 15_000 });
    await pageA
      .getByRole("button", { name: `Remove ${TRACK_ONE} from playlist` })
      .click();
    await expect(pageA.getByText(TRACK_ONE)).toHaveCount(0, {
      timeout: 15_000,
    });

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(
      pageA.getByRole("heading", { name: title }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByText(TRACK_ONE)).toHaveCount(0);
    await expect(pageA.getByText(TRACK_TWO)).toBeVisible();

    expect(dbPlaylistTrackTitles(playlistId)).toEqual([TRACK_TWO]);
  });
});
