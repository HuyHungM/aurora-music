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
    const title = "E2E Create";
    const playlistId = await createPlaylistViaUI(pageA, title);
    expect(playlistId.length).toBeGreaterThan(0);

    // Re-enter through the library: the new playlist card is listed.
    await pageA.goto("/library");
    await expect(pageA.getByText(title)).toBeVisible();
    await pageA.getByText(title).click();
    await pageA.waitForURL(`/library/playlists/${playlistId}`);
    await expect(
      pageA.getByRole("heading", { name: title }),
    ).toBeVisible();
    await expect(pageA.getByText("This playlist is empty")).toBeVisible();
  });

  authTest("Journey 2: add track persists across reload", async ({ pageA }) => {
    const title = "E2E Add";
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
    const title = "E2E Duplicate";
    const playlistId = await createPlaylistViaUI(pageA, title);
    await addFixtureTrackViaUI(pageA, TRACK_ONE, title);

    // Add the same track again: the Phase 28 conflict semantics must
    // hold — a safe error, no success mark, no second membership.
    await pageA.goto("/e2e-library");
    await pageA.getByRole("button", { name: `Actions for ${TRACK_ONE}` }).click();
    await pageA.getByRole("menuitem", { name: "Add to playlist" }).click();
    const submenu = pageA.getByRole("menu", { name: "Add to playlist" });
    await expect(submenu).toBeVisible();
    await submenu.getByRole("menuitem", { name: new RegExp(title) }).click();
    await expect(submenu.getByRole("alert")).toContainText(
      "Failed to add track to playlist",
      { timeout: 15_000 },
    );

    expect(dbPlaylistTrackTitles(playlistId)).toEqual([TRACK_ONE]);
  });

  authTest("Journey 4: reorder persists across reload", async ({ pageA }) => {
    const title = "E2E Reorder";
    const playlistId = await createPlaylistViaUI(pageA, title);
    await addFixtureTrackViaUI(pageA, TRACK_ONE, title);
    await addFixtureTrackViaUI(pageA, TRACK_TWO, title);

    await pageA.goto(`/library/playlists/${playlistId}`);
    await expect(pageA.getByText(TRACK_TWO)).toBeVisible({ timeout: 15_000 });
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
    await expect(pageA.getByText(TRACK_TWO)).toBeVisible({ timeout: 30_000 });
    order = await orderOnDetailPage(pageA);
    expect(order.two).toBeLessThan(order.one);

    expect(dbPlaylistTrackTitles(playlistId)).toEqual([
      TRACK_TWO,
      TRACK_ONE,
    ]);
  });

  authTest("Journey 5: remove stays absent across reload", async ({ pageA }) => {
    const title = "E2E Remove";
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
