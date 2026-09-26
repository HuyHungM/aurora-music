import { test, expect } from "@playwright/test";

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";
// Search-to-play needs the metadata API key on BOTH sides (spec process
// for the gate, server process for results — the server inherits env).
const SEARCH_LIVE = LIVE && !!process.env.YOUTUBE_API_KEY;

test.describe("live search-to-play (Scenario B)", () => {
  test.skip(
    !SEARCH_LIVE,
    "Requires AURORA_E2E_LIVE_PLAYBACK=1 and YOUTUBE_API_KEY.",
  );

  test("unified result plays through MusicEngine to real audio", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.goto("/search?q=Never%20Gonna%20Give%20You%20Up");
    // The results section is labelled with `search.tracksSection`, whose
    // English value is "Tracks" — the same string as its visible heading. The
    // selector is matched on the role and accessible name rather than on
    // `section[aria-label=...]` so it is anchored to what a user of assistive
    // technology would be told, which is the thing that must not drift.
    const results = page.getByRole("region", { name: "Tracks" });
    await expect(results).toBeVisible({ timeout: 60_000 });
    await results.getByRole("button", { name: /^Play / }).first().click();
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible({ timeout: 60_000 });
    const slider = page.locator('input[aria-label="Seek"]').first();
    const t0 = Number(await slider.inputValue());
    await expect(async () => {
      expect(Number(await slider.inputValue())).toBeGreaterThan(t0);
    }).toPass({ timeout: 30_000 });
    await expect(page.getByRole("status")).toHaveCount(0);
  });
});
