import { test, expect } from "@playwright/test";

/**
 * Keyboard operability (Phase 23). Fully offline-safe: no YouTube, no
 * credentials, no playback required. The empty-queue dialog exercises the
 * real QueuePanel focus lifecycle.
 */
test.describe("keyboard operability", () => {
  test("tab traversal reaches player controls through landmarks", async ({
    page,
  }) => {
    await page.goto("/");
    const seen: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) {
          return "body";
        }
        return (
          el.getAttribute("aria-label") ||
          (el as HTMLInputElement).placeholder ||
          el.textContent?.trim().slice(0, 40) ||
          el.tagName
        );
      });
      seen.push(label);
      if (label === "Up next") {
        break;
      }
    }
    expect(seen).toContain("Up next");
    expect(seen.some((entry) => /search/i.test(entry))).toBe(true);
  });

  test("queue opens by keyboard with focus inside, escape restores it", async ({
    page,
  }) => {
    await page.goto("/");
    let focused = "";
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press("Tab");
      focused =
        (await page.evaluate(
          () => document.activeElement?.getAttribute("aria-label") ?? "",
        )) as string;
      if (focused === "Up next") {
        break;
      }
    }
    expect(focused).toBe("Up next");

    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Queue" });
    await expect(dialog).toBeVisible();
    expect(
      await page.evaluate(() => {
        const panel = document.querySelector('[aria-label="Queue"]');
        return !!panel && panel.contains(document.activeElement);
      }),
    ).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.activeElement?.getAttribute("aria-label"),
      ),
    ).toBe("Up next");
  });
});
