import { test, expect } from "@playwright/test";
import { FIXTURE_A, fixtureUrl } from "./fixtures";
import {
  expectMediaLoaded,
  expectPlaybackAdvancing,
  expectPlaybackPaused,
} from "./helpers/assertPlayback";

const LIVE = process.env.AURORA_E2E_LIVE_PLAYBACK === "1";

test.describe("live media session smoke (Chromium)", () => {
  test.skip(
    !LIVE,
    "Live provider suite is opt-in: set AURORA_E2E_LIVE_PLAYBACK=1.",
  );

  test("metadata and playbackState follow real playback", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto(fixtureUrl(FIXTURE_A.providerTrackId));
    const caps = await page.evaluate(() => ({
      session:
        typeof navigator !== "undefined" && "mediaSession" in navigator,
      metadata:
        typeof (globalThis as unknown as Record<string, unknown>)
          .MediaMetadata === "function",
    }));
    test.skip(
      !caps.session || !caps.metadata,
      "Media Session unavailable in this browser build.",
    );

    await expect(
      page.getByRole("heading", { name: FIXTURE_A.titleFragment }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /^Play / }).first().click();

    // `mediaSession.playbackState` is the app's own report about playback. It
    // can read "playing" for a stream that never moved, so it is corroborated
    // here by the media element actually advancing.
    await expectMediaLoaded(page);
    await expectPlaybackAdvancing(page);

    // Observable browser integration (no lock-screen automation): the
    // metadata title matches the playing fixture and the state is playing.
    await expect(async () => {
      const snapshot = await page.evaluate(() => ({
        title: navigator.mediaSession.metadata?.title ?? null,
        state: navigator.mediaSession.playbackState,
      }));
      expect(snapshot.title).toContain(FIXTURE_A.titleFragment);
      expect(snapshot.state).toBe("playing");
    }).toPass({ timeout: 30_000 });

    await page.getByRole("button", { name: /^Pause / }).first().click();
    await expect(async () => {
      const state = await page.evaluate(
        () => navigator.mediaSession.playbackState,
      );
      expect(state).toBe("paused");
    }).toPass({ timeout: 15_000 });

    // And the media element really stopped, not just the reported state.
    await expectPlaybackPaused(page);
  });
});
