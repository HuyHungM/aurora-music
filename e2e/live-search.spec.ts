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
    // UI-LEVEL evidence, deliberately labelled as such.
    //
    // The real media oracle (`helpers/assertPlayback.ts`) reads a probe that is
    // mounted ONLY by the `/e2e-playback` fixture route. This test drives
    // `/search`, so no probe exists here and asserting media state would fail
    // with UI_SELECTOR_FAILURE rather than test anything.
    //
    // So this asserts the strongest thing genuinely available on this route -
    // the UI transitioned to playing - and does NOT dress it up as proof that
    // audio advanced. Media-level playback proof lives in `live-playback.spec.ts`
    // against the same production code path. The previous version here read
    // `input[aria-label="Seek"]`, which is precisely the selector that produced
    // the "missing slider means NOT_PLAYING" misdiagnosis.
    await expect(
      page.getByRole("button", { name: /^Pause / }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("status")).toHaveCount(0);
  });
});
