/**
 * Authenticated radio journeys (Phase 41). Real browser, real session,
 * deterministic fixture discovery backend (AURORA_E2E_AUTH=1): the
 * seeded `e2e-` catalog answers every discovery avenue, so no live
 * provider is needed. Playback resolution is expected to fail for
 * fixture ids; journeys assert queue/session behavior, never audio.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_ARTIST, FIXTURE_TRACKS, TEST_USERS } from "./auth/constants";
import { dbIsArtistFollowed, dbQueueSnapshotJson } from "./auth/run";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_TWO = FIXTURE_TRACKS[1].title;
const USER_A = TEST_USERS[0].email;

const queueDialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Queue" });

async function openQueue(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Up next" }).first().click();
  await expect(queueDialog(page)).toBeVisible();
}

async function startTrackRadio(
  page: import("@playwright/test").Page,
  trackTitle: string,
) {
  await page.goto("/e2e-library");
  await expect(
    page.getByRole("heading", { name: "E2E fixture library" }),
  ).toBeVisible();
  // Scoped to the page: the Player bar restores the previous journey's
  // persisted queue and renders an identically named row menu for the same
  // track, so an unscoped lookup resolves to two elements and trips strict
  // mode. The library row is the one that owns the radio menu items.
  await page
    .getByRole("main")
    .getByRole("button", { name: `Actions for ${trackTitle}` })
    .click();
  await page
    .getByRole("menuitem", { name: `Start radio from ${trackTitle}` })
    .click();
}

authTest.describe("authenticated radio journeys", () => {
  authTest("Journey 14: track radio builds a seed-first queue", async ({
    pageA,
  }) => {
    await startTrackRadio(pageA, TRACK_ONE);
    await openQueue(pageA);
    const dialog = queueDialog(pageA);
    // Wait for the station to exist BEFORE reading the panel. Starting a
    // station is a server round trip, so the panel can still be showing the
    // empty state here; reading it once and asserting on the result measures
    // the race, not the product. Same reasoning as Journeys 18 and 19.
    await expect(dialog.getByText(/Radio from /).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      dialog.locator("li", { hasText: TRACK_TWO }),
    ).toBeVisible({ timeout: 15_000 });
    // Seed plays first, generated tracks follow.
    const text = (await dialog.textContent()) ?? "";
    expect(text.indexOf(TRACK_ONE)).toBeLessThan(text.indexOf(TRACK_TWO));
    expect(text.indexOf(TRACK_TWO)).toBeGreaterThanOrEqual(0);
    await expect(
      // Locale is English for every authenticated context: e2e/auth/db.ts
      // pins User.locale = "en", so this page renders the "en" bundle
      // regardless of the browser's Accept-Language.
      dialog
        .locator("li", { hasText: TRACK_ONE })
        .getByText("Now playing", { exact: true }),
    ).toBeVisible();
    // Persisted as ordinary queue entries (Phase 40 compatibility).
    // The snapshot write is debounced, so poll for it.
    await expect(async () => {
      const raw = JSON.stringify(dbQueueSnapshotJson(USER_A));
      expect(raw).toContain("e2e-track-1");
      expect(raw).toContain("e2e-track-2");
      expect(raw).not.toContain("googlevideo");
    }).toPass({ timeout: 15_000 });
  });

  authTest("Journey 15: skip advances within the radio queue", async ({
    pageA,
  }) => {
    await startTrackRadio(pageA, TRACK_ONE);
    await pageA
      .getByRole("region", { name: "Player bar" })
      .getByRole("button", { name: "Next track" })
      .click();
    await openQueue(pageA);
    // Current moved to Track Two; the station is still active.
    await expect(
      queueDialog(pageA).getByText(/Radio from /).first(),
    ).toBeVisible();
  });

  authTest("Journey 16: manual playback wins over radio", async ({
    pageA,
  }) => {
    await startTrackRadio(pageA, TRACK_ONE);
    await openQueue(pageA);
    await expect(
      queueDialog(pageA).getByText(/Radio from /).first(),
    ).toBeVisible();
    await pageA.getByRole("button", { name: "Close queue" }).click();

    // Manual play replaces the queue: the session ends immediately.
    await pageA.goto("/e2e-library");
    await pageA.getByRole("button", { name: `Play ${TRACK_TWO}` }).click();
    await openQueue(pageA);
    await expect(
      queueDialog(pageA).getByText(/Radio from /),
    ).toHaveCount(0);
    // No refill: the queue stays exactly the manual single track.
    await pageA.waitForTimeout(1500);
    const text = (await queueDialog(pageA).textContent()) ?? "";
    expect(text).toContain(TRACK_TWO);
    expect(text).not.toContain(TRACK_ONE);
  });

  authTest("Journey 17: exhaustion surfaces when the catalog runs dry", async ({
    pageA,
  }) => {
    await startTrackRadio(pageA, TRACK_ONE);
    // Consume the two-track fixture station: start already triggered
    // the first (empty) extension; advancing to the end triggers the
    // second, which exhausts the station.
    await pageA
      .getByRole("region", { name: "Player bar" })
      .getByRole("button", { name: "Next track" })
      .click();
    await openQueue(pageA);
    await expect(
      // English: e2e/auth/db.ts pins User.locale = "en" for the synthetic
      // users, so this context renders the "en" bundle.
      queueDialog(pageA).getByText("Radio ran out of recommendations."),
    ).toBeVisible({ timeout: 20_000 });
  });

  authTest("Journey 18: discovery radio starts from /radio", async ({
    pageA,
  }) => {
    await pageA.goto("/radio");
    await pageA.getByRole("button", { name: "Start discovery radio" }).click();
    await openQueue(pageA);
    // Wait for the station to exist BEFORE reading its contents. The queue panel
    // opens empty while a station is still being generated - that is the
    // correct loading state, and Journeys 14-17 already assert it resolves - so
    // a single immediate read of the panel is a race against the generation,
    // not a product failure. Reading a value that is filled in asynchronously
    // without first waiting for it to exist is the defect here.
    await expect(
      queueDialog(pageA).getByText("Discovery Radio"),
    ).toBeVisible({ timeout: 20_000 });
    const text = (await queueDialog(pageA).textContent()) ?? "";
    expect(text).toContain(TRACK_ONE);
    expect(text).toContain(TRACK_TWO);
  });

  authTest("Journey 19: artist radio starts from a followed artist", async ({
    pageA,
  }) => {
    // Follow the fixture artist first (deterministic, no provider page).
    await pageA.goto("/e2e-library");
    // `exact: true` is load-bearing, not decoration. Playwright matches a
    // `getByRole` name case-insensitively and by SUBSTRING by default, so
    // "Follow Aurora E2E Artist" also matches "Unfollow Aurora E2E Artist".
    // Without it, whenever the artist was already followed this locator
    // resolved to the Unfollow control, the click UNfollowed the artist, and
    // the wait below then looked for a button the test had just removed —
    // a ~40% flake that looked exactly like a follow bug.
    const follow = pageA.getByRole("button", {
      name: `Follow ${FIXTURE_ARTIST.name}`,
      exact: true,
    });
    if (await follow.isVisible()) {
      await follow.click();
      await expect(
        pageA.getByRole("button", {
          name: `Unfollow ${FIXTURE_ARTIST.name}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 15_000 });
    }
    expect(dbIsArtistFollowed(USER_A)).toBe(true);

    await pageA.goto("/radio");
    await expect(pageA.getByText(FIXTURE_ARTIST.name).first()).toBeVisible({
      timeout: 15_000,
    });
    await pageA
      .getByRole("button", { name: `Start radio from ${FIXTURE_ARTIST.name}` })
      .click();
    await openQueue(pageA);
    // Same reasoning as Journey 18: wait for the station to appear before
    // reading the panel, so this is not a race against generation.
    await expect(
      queueDialog(pageA).getByText(/Radio from /).first(),
    ).toBeVisible({ timeout: 20_000 });
    const text = (await queueDialog(pageA).textContent()) ?? "";
    expect(text).toContain(TRACK_ONE);
    expect(text).toContain(TRACK_TWO);
  });
});
