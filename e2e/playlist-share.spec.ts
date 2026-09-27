/**
 * Playlist sharing contract, verified in a real browser against a real
 * authenticated session.
 *
 * The unit gate in
 * `src/components/playlist/__tests__/playlist-share-control.test.tsx` proves
 * the control calls the right action with the right arguments and renders each
 * state. It cannot prove the things a redesign of a dialog is actually judged
 * on: that the layout does not break at a phone width, that the share link
 * appears at all once the server has minted a token, that revoking it takes the
 * link away, or that the copy control is reachable by tapping rather than only
 * by mouse. Those are claims only a running engine settles.
 *
 * Every assertion runs on `pageA`, never the default `page`. The share control
 * is owner-only and lives on a playlist page, so a spec that quietly ran
 * signed-out would assert against a page that does not have the feature at all
 * - and would pass for the wrong reason.
 *
 * Visual review is NOT duplicated here. This spec captures the dialog at the
 * viewports that matter so a human (or a review pass) can look at them; the
 * assertions are the objective half - geometry, reachability, and the state
 * transitions - which a screenshot can never prove on its own.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { authTest, expect } from "./auth/fixtures";

/**
 * Where the dialog is captured for visual review: the OS temp directory, so
 * this spec - which CI runs on Linux - does not create a literal `C:` folder
 * inside the checkout or assume one particular Windows profile.
 */
const SHOTS = join(tmpdir(), "aurora-share-qa");

/**
 * A capture is a review aid, never an assertion: the contract is proved by the
 * `expect`s above, so a machine that cannot write a PNG must not be able to
 * fail a test whose claim has already been established.
 */
async function capture(page: Page, name: string): Promise<void> {
  try {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  } catch {
    // Review aid only - see the note above.
  }
}

/**
 * The widths a share dialog has to survive: the two common desktop sizes, the
 * tablet breakpoint where the two-column collapses, and the two phone widths
 * where a long URL and a full-width pair of buttons are the binding
 * constraints.
 */
const VIEWPORTS = [
  { name: "desktop-1366x768", width: 1366, height: 768 },
  { name: "desktop-1920x1080", width: 1920, height: 1080 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "mobile-390x844", width: 390, height: 844 },
  { name: "mobile-360x800", width: 360, height: 800 },
] as const;

let titleSequence = 0;

function uniqueTitle(prefix: string): string {
  titleSequence += 1;
  return `${prefix} ${process.pid}-${titleSequence}`;
}

/**
 * Creates a playlist through the real dialog and returns its id.
 *
 * The field is labelled "Name", not "Title". `e2e/canonical-dedupe.spec.ts:52`
 * asks for "Title" and fails on this - see the report; the accessible label
 * comes from `t("playlist.nameLabel")`, while "playlist-title" is only the
 * element's `id`.
 */
async function createPlaylist(
  page: import("@playwright/test").Page,
  title: string,
): Promise<string> {
  await page.goto("/library");
  await page.getByRole("button", { name: "Create playlist" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill(title);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/library\/playlists\//);
  return page.url().split("/library/playlists/")[1].split("?")[0];
}

/** Opens the share dialog on the current playlist page. */
async function openShareDialog(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Share playlist" })).toBeVisible();
  return dialog;
}

authTest.describe("playlist sharing", () => {
  const title = uniqueTitle("Share QA");

  authTest.afterEach(async ({ pageA }) => {
    // Leaving a fixture playlist publicly shared would let one spec's state leak
    // into every later run against the same database.
    await pageA
      .getByRole("button", { name: "Share", exact: true })
      .click()
      .catch(() => undefined);
    const dialog = pageA.getByRole("dialog");
    if (await dialog.isVisible().catch(() => false)) {
      await dialog
        .getByRole("button", { name: "Private", exact: true })
        .click()
        .catch(() => undefined);
    }
  });

  authTest("names the playlist, states the state, and hides the link while private", async ({
    pageA,
  }) => {
    const id = await createPlaylist(pageA, title);
    const dialog = await openShareDialog(pageA);

    // WHAT: the dialog is about a specific playlist, not a form with no subject.
    await expect(dialog.getByText(title, { exact: true })).toBeVisible();
    await expect(dialog.getByText("0 tracks")).toBeVisible();

    // WHETHER, in words.
    await expect(
      dialog.getByText("This playlist isn't shared. Only you can see it."),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Private", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      dialog.getByRole("button", { name: "Public", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");

    // HOW: nothing to copy yet, and no link is offered.
    await expect(dialog.getByRole("button", { name: "Copy link" })).toHaveCount(0);
    // §2/§9: the internal id never reaches the dialog, in any state.
    await expect(dialog).not.toContainText(id);

    // Captured for review: this is the state every first-time user meets, and
    // the only one where the dialog's primary payload (the link) is absent.
    // Wait out the entrance animation first - `toBeVisible()` only proves a
    // non-empty box, and shooting earlier catches the backdrop still at
    // ~0 opacity, which looks like a missing dialog rather than a fading one.
    await pageA.waitForTimeout(600);
    await capture(pageA, "state-private");
  });

  authTest("publishes, offers a token-only link, copies it, and withdraws it", async ({
    pageA,
  }) => {
    const id = await createPlaylist(pageA, `${title} two`);
    const dialog = await openShareDialog(pageA);

    await dialog.getByRole("button", { name: "Public", exact: true }).click();

    // The link appears only after the server confirmed and minted a token.
    const field = dialog.getByLabel("Share link");
    await expect(field).toBeVisible({ timeout: 10_000 });
    const value = await field.inputValue();

    // §2/§9: the URL is the token and nothing else. No playlist id, no owner id.
    // The token is base64url, so the alphabet is URL-safe, not alphanumeric -
    // `[A-Za-z0-9]` alone would reject a perfectly valid token that happened to
    // contain `-` or `_`, and a spec that rejects valid input teaches its
    // readers to distrust it.
    expect(value).toMatch(/\/playlist\/share\/[A-Za-z0-9_-]+$/);
    expect(value).not.toContain(id);

    // The state now explains the permission instead of the next action.
    await expect(
      dialog.getByText(
        "Anyone with this link can view and play the playlist. They can't edit it.",
      ),
    ).toBeVisible();
    // §15: the consequence of revoking is stated before the user does it.
    await expect(
      dialog.getByText(
        "Turning sharing off invalidates the current public link immediately.",
      ),
    ).toBeVisible();

    // The copy control is reachable and reports itself in words. The grant is
    // explicit because headless Chromium refuses `navigator.clipboard` without
    // it - and the refusal is worth a test of its own below, rather than being
    // an accident of the environment.
    await pageA.context().grantPermissions(["clipboard-write", "clipboard-read"]);
    const copy = dialog.getByRole("button", { name: "Copy link" });
    await expect(copy).toBeVisible();
    await copy.click();
    await expect(dialog.getByRole("button", { name: "Link copied" })).toBeVisible();

    // The clipboard really holds the URL, not just the label that claims so.
    const clipboard = await pageA.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(value);

    // §10: "Copied" is a temporary claim, not a permanent badge.
    await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible({
      timeout: 8000,
    });

    // Revoking takes the link away immediately.
    await dialog.getByRole("button", { name: "Private", exact: true }).click();
    await expect(dialog.getByLabel("Share link")).toHaveCount(0, { timeout: 10_000 });
  });

  authTest("the public link actually opens the playlist for a signed-out visitor", async ({
    pageA,
    browser,
  }) => {
    await createPlaylist(pageA, `${title} three`);
    const dialog = await openShareDialog(pageA);
    await dialog.getByRole("button", { name: "Public", exact: true }).click();
    const field = dialog.getByLabel("Share link");
    await expect(field).toBeVisible({ timeout: 10_000 });
    const shareUrl = await field.inputValue();

    // A fresh context: no session, exactly a person who was sent the link.
    {
      const context = await browser.newContext();
      try {
        const guest = await context.newPage();
        const response = await guest.goto(shareUrl);
        expect(response?.status()).toBe(200);
        await expect(guest.getByText(`${title} three`, { exact: true }).first()).toBeVisible();
        // A viewer is not offered the owner's controls.
        await expect(guest.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);
      } finally {
        await context.close();
      }
    }

    // ...and revoking really does invalidate it, rather than merely hiding the
    // field in the owner's dialog. A second, separate context: reusing the
    // closed one would test the teardown, not the revocation.
    await dialog.getByRole("button", { name: "Private", exact: true }).click();
    await expect(dialog.getByLabel("Share link")).toHaveCount(0, { timeout: 10_000 });
    {
      const context = await browser.newContext();
      try {
        const after = await context.newPage();
        await after.goto(shareUrl);
        // A revoked token calls `notFound()`, so the body is the app's generic
        // 404. That is deliberate - a revoked link must be indistinguishable
        // from a wrong one - so the assertion is on the 404 and on the
        // playlist's ABSENCE, not on the "isn't available" string, which
        // reaches only the document title via `generateMetadata`.
        await expect(after.getByRole("heading", { name: "Page not found" })).toBeVisible();
        await expect(after.getByText(`${title} three`, { exact: true })).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  });

  // §24, stage one of the degradation. The async clipboard is a
  // SECURE-CONTEXT-ONLY API: an un-granted headless context refuses it, and a
  // plain-HTTP origin - exactly how a phone opens the dev server over the LAN -
  // does not expose it at all. Refusing it must NOT be reported as a failure
  // while the synchronous copy every browser still ships is sitting right
  // there, because that message would tell a phone user sharing a playlist is
  // broken when the copy in fact succeeded.
  authTest("a refused async clipboard still copies through the legacy path", async ({
    pageA,
  }) => {
    await createPlaylist(pageA, `${title} six`);
    const dialog = await openShareDialog(pageA);
    await dialog.getByRole("button", { name: "Public", exact: true }).click();
    await expect(dialog.getByLabel("Share link")).toBeVisible({ timeout: 10_000 });

    // Force the refusal the engine would give anyway, and count the calls that
    // reach the synchronous path so the success below cannot be earned by the
    // async API quietly working after all.
    await pageA.evaluate(() => {
      const probe = window as unknown as { legacyCopyCalls?: number };
      probe.legacyCopyCalls = 0;
      const real = document.execCommand.bind(document);
      document.execCommand = (command: string): boolean => {
        probe.legacyCopyCalls = (probe.legacyCopyCalls ?? 0) + 1;
        return real(command);
      };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () =>
            Promise.reject(
              new DOMException("Write permission denied.", "NotAllowedError"),
            ),
        },
      });
    });

    await dialog.getByRole("button", { name: "Copy link" }).click();

    await expect(dialog.getByRole("button", { name: "Link copied" })).toBeVisible();
    expect(
      await pageA.evaluate(
        () => (window as unknown as { legacyCopyCalls?: number }).legacyCopyCalls,
      ),
    ).toBeGreaterThan(0);
    // The copy happened, so nothing may claim it failed.
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await capture(pageA, "state-copied-legacy");
  });

  // §24, stage two. When BOTH mechanisms are refused - no async clipboard and no
  // synchronous copy - the product must admit it: a readable failure, never a
  // silent no-op and never a "Copied" that did not happen, with the URL left in
  // a selectable field so the manual remedy the message names is real.
  authTest("a clipboard that refuses both paths produces an honest failure", async ({
    pageA,
  }) => {
    await createPlaylist(pageA, `${title} seven`);
    const dialog = await openShareDialog(pageA);
    await dialog.getByRole("button", { name: "Public", exact: true }).click();
    await expect(dialog.getByLabel("Share link")).toBeVisible({ timeout: 10_000 });

    await pageA.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () =>
            Promise.reject(
              new DOMException("Write permission denied.", "NotAllowedError"),
            ),
        },
      });
      // The synchronous path refuses too, as a browser without it would.
      document.execCommand = (): boolean => false;
    });

    await dialog.getByRole("button", { name: "Copy link" }).click();

    await expect(dialog.getByRole("alert")).toBeVisible();
    // The message names the manual remedy rather than leaking a raw API error.
    await expect(
      dialog.getByText("Couldn't copy the link. Select it and copy manually."),
    ).toBeVisible();
    // And it must not claim the copy happened.
    await expect(dialog.getByRole("button", { name: "Link copied" })).toHaveCount(0);
    // The link stays in the field and stays SELECTABLE, which is what makes the
    // manual remedy possible at all. It is deliberately `readOnly` - a user
    // editing their own share token would break the link for everyone - but a
    // read-only field still selects and copies with Ctrl+C, which is the whole
    // point of the fallback message naming manual selection.
    const field = dialog.getByLabel("Share link");
    const shown = await field.inputValue();
    expect(shown).toMatch(/\/playlist\/share\/[A-Za-z0-9_-]+$/);
    await expect(field).toHaveCSS("user-select", "text");
    await pageA.waitForTimeout(600);
    await capture(pageA, "state-error");
  });

  authTest("survives every viewport without horizontal overflow", async ({ pageA }, testInfo) => {
    await createPlaylist(pageA, `${title} four`);
    const dialog = await openShareDialog(pageA);
    await dialog.getByRole("button", { name: "Public", exact: true }).click();
    await expect(dialog.getByLabel("Share link")).toBeVisible({ timeout: 10_000 });

    for (const viewport of VIEWPORTS) {
      await pageA.setViewportSize({ width: viewport.width, height: viewport.height });
      // Let the resize settle before measuring: the dialog is centred with a
      // max-height, so a reading taken mid-transition is a reading of nothing.
      await pageA.waitForTimeout(150);

      // §17/§25: neither the page nor the dialog may scroll sideways. The URL
      // is the thing most likely to force this, which is why the measurement is
      // taken with the link present.
      const pageOverflow = await pageA.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(pageOverflow, `page overflows at ${viewport.name}`).toBeLessThanOrEqual(0);

      const dialogOverflow = await dialog.evaluate((node) => {
        const panel = node.querySelector("[role=dialog]") ?? node;
        return panel.scrollWidth - panel.clientWidth;
      });
      expect(dialogOverflow, `dialog overflows at ${viewport.name}`).toBeLessThanOrEqual(0);

      // §21: the link is the payload and must stay selectable; §22: the copy
      // control is an action and must be a real, tappable target.
      await expect(dialog.getByLabel("Share link")).toHaveCSS("user-select", "text");
      const copyBox = await dialog
        .getByRole("button", { name: "Copy link" })
        .boundingBox();
      expect(copyBox, `copy button has no box at ${viewport.name}`).not.toBeNull();
      // Touch-primary widths get the repository's 44px floor from
      // `.aurora-touch`; a phone-sized dialog that offers a 32px button is a
      // regression the desktop viewport would never show.
      if (viewport.width < 768) {
        expect(copyBox!.height).toBeGreaterThanOrEqual(40);
      }

      await capture(pageA, viewport.name);
    }

    await testInfo.attach("share-dialog-360", {
      body: await pageA.screenshot({ fullPage: false }),
      contentType: "image/png",
    });
  });

  authTest("closes on Escape and on the close control, leaving no trace", async ({ pageA }) => {
    await createPlaylist(pageA, `${title} five`);
    const dialog = await openShareDialog(pageA);
    await dialog.getByRole("button", { name: "Public", exact: true }).click();
    await expect(dialog.getByLabel("Share link")).toBeVisible({ timeout: 10_000 });

    // §32: Escape works.
    await pageA.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Reopening shows the link that was already minted - a refresh must not
    // mint a second token, and the persisted link must be what is offered.
    const reopened = await openShareDialog(pageA);
    await expect(reopened.getByLabel("Share link")).toBeVisible();
    const firstUrl = await reopened.getByLabel("Share link").inputValue();

    // `exact` is load-bearing: the panel's close icon is labelled "Close
    // dialog", so a substring match resolves to two controls and Playwright
    // refuses rather than guessing which one closes the dialog.
    await reopened.getByRole("button", { name: "Close", exact: true }).click();
    await expect(reopened).toBeHidden();

    const again = await openShareDialog(pageA);
    await expect(again.getByLabel("Share link")).toHaveValue(firstUrl);
  });
});
