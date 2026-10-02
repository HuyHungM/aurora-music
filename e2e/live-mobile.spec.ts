import { test, expect } from "@playwright/test";
import { FIXTURE_A, fixtureUrl } from "./fixtures";
import {
  expectMediaLoaded,
  expectPlaybackAdvancing,
} from "./helpers/assertPlayback";

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";

test.describe("live playback on a mobile viewport", () => {
  test.skip(
    !LIVE,
    "Live provider suite is opt-in: set AURORA_E2E_LIVE_PLAYBACK=1.",
  );
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("mini player stays reachable and audio progresses", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Play / }).first().tap();

    // Media-state oracle, not the (visually hidden) desktop seek input: the
    // slider exists on this viewport but is hidden, so reading it told us
    // about a control rather than about playback. See helpers/assertPlayback.ts.
    await expectMediaLoaded(page);
    await expectPlaybackAdvancing(page);

    await expect(
      page.getByRole("region", { name: "Mini player" }),
    ).toBeVisible();
  });
});
