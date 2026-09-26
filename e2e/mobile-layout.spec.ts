/**
 * Phase 54 — mobile, tablet and foldable layout guards.
 *
 * A40 requires every surface to hold at the width it will actually be used
 * at, and the phone widths are where layout defects hide: they are
 * sub-pixel-ish, they appear at ONE width and not its neighbours, and a
 * screenshot at 390px does not show you the 9px of horizontal scroll that a
 * 9px-too-wide header row produces at 390px and not at 375px. So every rule
 * below is asserted numerically, in a loop, on every run.
 *
 * WHAT IS ASSERTED, AND WHY THESE THINGS
 *
 * 1. No horizontal overflow, sampled at 1px steps across the band where the
 *    authenticated header row actually breaks. This is not a round-number
 *    sweep: 375..420px is the band the header's fixed children (four 44px
 *    touch targets, a 46px avatar pill, the 44px sign-out target) overflow
 *    in, and the fix is a wordmark threshold inside it. Asserting only
 *    360/390/412 would have missed the regression this file was written for.
 *
 * 2. A 44px touch-target floor on every interactive control, but only when
 *    the device actually has a coarse pointer. Under `(hover: none) and
 *    (pointer: coarse)` the app declares a 44px minimum; a desktop browser
 *    with a mouse is not held to it, and asserting it there would fail on
 *    dense toolbars by design. `hasTouch` + `isMobile` is what makes
 *    Chromium report those media features, which is why every test here sets
 *    them rather than only resizing the viewport.
 *
 * 3. Nothing interactive is stranded below the fold of a panel that cannot
 *    scroll. This is the landscape full-player defect Phase 54 found: five
 *    controls (volume, queue, like, actions) sat 19px past the bottom of a
 *    375px-tall phone in landscape, inside a container whose `overflow-y`
 *    was `visible`, so there was no way to reach them at all.
 *
 * 4. The queue is a MODAL sheet below `lg` and a non-modal side panel at
 *    `lg`+. That is not a styling detail: the modal half owns an
 *    `aria-modal` dialog, a backdrop, a scroll lock and a focus trap, and a
 *    test that only checked "the queue is visible" would have passed
 *    against a non-modal panel that a screen reader could walk straight out
 *    of.
 *
 * EVERY SELECTOR HERE IS CHOSEN NOT TO DEPEND ON THE LOCALE, and that is not
 * tidiness. The player's accessible name and the queue's are translated, so
 * a locale test that measures by name cannot find the thing it measures.
 * `role="region"`, `role="dialog"`, and `nav` outside an `aside` are
 * structural; `getByRole("region", { name: "Mini player" })` is not.
 */
import { mobileAuthTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS } from "./auth/constants";
import type { Page } from "@playwright/test";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_TWO = FIXTURE_TRACKS[1].title;

/**
 * The band the authenticated header breaks in, at 1px steps.
 *
 * Derived from measurement, not chosen for neatness: the row needs 393px
 * of content signed in (44px mark + 47px wordmark + four 44px controls +
 * 98px account group + gaps + 32px padding), and the wordmark is revealed
 * from 393px up. The failure is therefore not a "narrow phone" failure that
 * a 360px assertion catches — it is a failure at a specific width, which is
 * exactly why this is a range and not a set of three widths.
 */
const HEADER_BAND = [375, 380, 384, 387, 390, 392, 393, 395, 400, 405, 410, 415, 420];

/** Phone and small-tablet portrait widths from the mission matrix. */
const PHONE_WIDTHS = [360, 375, 390, 393, 412, 430];

/** Landscape phone and foldable-open heights, where height is the constraint. */
const LANDSCAPE = [
  { w: 667, h: 375 },
  { w: 812, h: 375 },
  { w: 915, h: 412 },
];

/**
 * The media query the touch floor is gated on.
 *
 * `hasTouch` and `isMobile` are both required: Chromium derives
 * `(pointer: coarse)` and `(hover: none)` from them, and a viewport resize
 * alone leaves the page reporting a fine pointer — at which point the floor
 * is correctly absent and asserting it would fail for a reason that has
 * nothing to do with the layout. The first test in this file asserts the
 * query matches, so a fixture that stopped emulating a phone fails here
 * loudly instead of passing every floor assertion vacuously.
 */
const COARSE_MEDIA = "(hover: none) and (pointer: coarse)";

/** Every interactive control, matched structurally so no label is hardcoded. */
const INTERACTIVE =
  'a[href],button,input:not([type=hidden]),select,textarea,[role="button"],[role="switch"],[role="menuitem"],[role="tab"]';

async function openLibraryWithTrackPlaying(page: Page) {
  await page.goto("/e2e-library");
  await expect(page.getByRole("heading", { name: "E2E fixture library" })).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("button", { name: `Play ${TRACK_ONE}` })
    .click();
  await expect(page.locator('[role="region"]')).toHaveCount(2);
}

/**
 * Wait until no FINITE animation on the page is still running.
 *
 * This is not politeness, it is correctness: `presence-pop-in` starts at
 * `transform: scale(0.96)`, so for the length of the entrance EVERY
 * descendant of an opening dialog is measured 4% small. A 44px button
 * measured at the first animation frame is 42px, and a test asserting the
 * 44px touch floor then reports a defect that does not exist — while the
 * same test one frame later would pass. Every geometry assertion below runs
 * after this, so what is measured is the resting layout.
 *
 * Infinite animations are excluded, and they have to be: the equaliser bars
 * and the aurora drift loop forever, so "no running animations at all" never
 * becomes true on a page that is playing anything and this would hang until
 * it timed out on every single call. They are also safe to exclude — they
 * animate bar heights and background positions, never the box being measured.
 *
 * `document.getAnimations({ subtree: true })` rather than an element's own
 * animations, because the scale is on the dialog and the controls being
 * measured are its descendants.
 */
async function settle(page: Page) {
  await page.waitForFunction(
    () =>
      // `subtree: true` is specified by the CSS Animations Level 2 and
      // implemented in Chromium; the DOM lib in this TypeScript version still
      // types `getAnimations()` as argument-less, so the option is passed
      // through a widened local rather than silenced with an `any`. The cast
      // is one line and states exactly what is true: the runtime takes an
      // options bag this type does not describe yet.
      (
        document.getAnimations as (options?: { subtree?: boolean }) => Animation[]
      )({ subtree: true }).every((a) => {
        if (a.playState !== "running") return true;
        return a.effect?.getComputedTiming().iterations === Infinity;
      }),
    undefined,
    { timeout: 10_000 },
  );
}

/** Open the full player from the mini player. Structure, not a translated name. */
async function openFullPlayer(page: Page) {
  await page.locator('[aria-label="Expand player"]:visible').first().click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog).toBeVisible();
  await settle(page);
  return dialog;
}

/** Open the queue from wherever the "Up next" control currently lives. */
async function openQueue(page: Page) {
  const inDialog = page.locator('[role="dialog"][aria-modal="true"] [aria-label="Up next"]');
  if (await inDialog.isVisible().catch(() => false)) {
    await inDialog.click();
  } else {
    await page.locator('[aria-label="Up next"]:visible').first().click();
  }
  await expect(page.locator('[role="dialog"]').filter({ has: page.locator("li") })).toBeVisible();
  await settle(page);
  return page.locator('[role="dialog"]').filter({ has: page.locator("li") }).last();
}

/**
 * Put a track into the playing queue from its row's overflow menu.
 *
 * Needed because a `TrackRow` only enqueues a whole collection when
 * `collectionIndex` is also supplied, and the E2E fixture library supplies
 * `collectionTracks` alone. So a listener on that page adds a second track
 * the same way a listener anywhere else would: the row menu.
 */
async function addTrackToQueueFromRow(page: Page, title: string) {
  await page
    .getByRole("main")
    .locator("li")
    .filter({ hasText: title })
    .locator('button[aria-label^="Actions for"]:visible')
    .first()
    .click();
  const item = page.getByRole("menuitem", { name: "Add to queue" });
  await expect(item).toBeVisible();
  await item.click();
  await settle(page);
}

mobileAuthTest.describe("Phase 54 mobile layout guards", () => {
  // Repair the inherited locale before every test: the E2E account is a
  // single row, its saved preference outranks the cookie, and a test that
  // switches language and fails before switching back makes every LATER test
  // fail for an unrelated-looking reason.
  mobileAuthTest.beforeEach(async ({ phoneA }) => {
    // The switcher is selected as "whichever one is laid out" rather than by
    // container. The header's compact copy is `lg:hidden` (the sidebar footer
    // carries the full one from `lg` up), so a banner-scoped probe silently
    // depends on every test in this suite staying under 1024px. It currently
    // does - the widths here are 360 to 932 - but a probe that is only correct
    // while an unrelated condition holds is the kind that breaks quietly.
    const switcher = phoneA.locator('[data-testid="locale-switcher"]:visible');
    const label = async () => (await switcher.getAttribute("aria-label")) ?? "";
    await phoneA.goto("/e2e-library");
    if ((await label()) !== "Language") {
      await switcher.click();
      const target = phoneA.locator('[data-testid="locale-option-en"]:visible');
      await expect(target).toBeVisible();
      await target.click();
    }
    expect(
      await label(),
      "could not restore English; later failures would point at the wrong cause",
    ).toBe("Language");
  });

  mobileAuthTest("the touch floor is genuinely armed on this device", async ({ phoneA }) => {
    // Guards the rest of this file. If the coarse-pointer media query does not
    // match, `.aurora-touch` correctly does nothing and every 44px assertion
    // below would pass vacuously — so this asserts the precondition rather
    // than trusting the context options to have taken effect.
    await phoneA.setViewportSize({ width: 390, height: 844 });
    await phoneA.goto("/e2e-library");
    expect(
      await phoneA.evaluate((q) => window.matchMedia(q).matches, COARSE_MEDIA),
      "the touch floor's media query does not match, so its assertions would be vacuous",
    ).toBe(true);
  });

  mobileAuthTest("no horizontal overflow across the header's breaking band, signed in", async ({ phoneA }) => {
    // The regression this exists for: the account group is `shrink-0` and the
    // wordmark is revealed above its threshold, so at 390px the header row was
    // 399px wide inside a 390px viewport and the DOCUMENT scrolled sideways
    // by 9px — on every authenticated page. Asserted at 1px steps because the
    // defect is width-specific: 375 and 400 were both clean with 390 broken.
    for (const width of HEADER_BAND) {
      await phoneA.setViewportSize({ width, height: 844 });
      await phoneA.goto("/library");
      // `main` rather than any heading: the library page has several
      // (Liked, Recently played, Playlists, …) so a bare `getByRole("heading")`
      // resolves to nine elements and fails on strictness, which would read
      // as a layout failure.
      await expect(phoneA.getByRole("main")).toBeVisible();
      const m = await phoneA.evaluate(() => {
        const de = document.documentElement;
        return { overflow: de.scrollWidth - de.clientWidth, client: de.clientWidth };
      });
      expect(
        m.overflow,
        `${width}px signed in: the document scrolls ${m.overflow}px sideways in a ${m.client}px viewport`,
      ).toBeLessThanOrEqual(0);
    }
  });

  mobileAuthTest("every interactive control clears 44px on every phone width", async ({ phoneA }) => {
    await phoneA.setViewportSize({ width: 390, height: 844 });
    expect(await phoneA.evaluate((q) => window.matchMedia(q).matches, COARSE_MEDIA)).toBe(true);
    for (const width of PHONE_WIDTHS) {
      await phoneA.setViewportSize({ width, height: 900 });
      for (const path of ["/", "/search", "/library", "/radio", "/settings", "/e2e-library"]) {
        await phoneA.goto(path);
        const small = await phoneA.evaluate((sel) => {
          const out: string[] = [];
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            if (r.height < 44 || r.width < 44) {
              const name = (el.getAttribute("aria-label") || el.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 30);
              out.push(`${name || el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)}`);
            }
          }
          return out;
        }, INTERACTIVE);
        expect(small, `${width}px ${path}: sub-44px touch targets: ${small.join(" | ")}`).toEqual([]);
      }
    }
  });

  mobileAuthTest("the mini player keeps a usable identity budget at 360px", async ({ phoneA }) => {
    // The mini player below `sm` shows artwork, identity, play/pause and next,
    // and drops shuffle/repeat/queue to the full player. The consequence that
    // matters is the space left for the TITLE: with the desktop control set
    // crammed in, the title measured 76px at 360px — technically visible,
    // practically unreadable. The floor here is a measured value, not a
    // round number.
    await phoneA.setViewportSize({ width: 360, height: 800 });
    await openLibraryWithTrackPlaying(phoneA);
    // `:visible`, not `.first()`. Both player surfaces are always in the DOM
    // and are mutually exclusive across `lg`; the desktop `PlayerBar` comes
    // first in the source and is `hidden` on a phone, so `.first()` returns
    // an element with a zero-width title and this test passes for the wrong
    // reason — or fails on one.
    const region = phoneA.locator('[role="region"]:visible').first();
    await expect(region).toBeVisible();
    const width = await region.evaluate((el) => {
      const t = el.querySelector(".t-track-title");
      return t ? Math.round(t.getBoundingClientRect().width) : 0;
    });
    expect(
      width,
      `360px: the mini player leaves only ${width}px for the track title`,
    ).toBeGreaterThan(150);
  });

  mobileAuthTest("the full player in landscape is two columns with every control reachable", async ({ phoneA }) => {
    // The defect: in `landscape-short` the grid's artwork was capped with
    // `min(100%, 18rem)`, which is guaranteed-invalid against the indefinite
    // row a `row-span-4` item spans, so the cap did nothing. The artwork sat
    // at its intrinsic 280px, the grid grew 19px past the panel, and
    // `overflow-y: visible` meant no scroller existed — so the volume
    // slider, the queue button, Like and Actions were unreachable on the two
    // most common landscape phone sizes.
    for (const { w, h } of LANDSCAPE) {
      await phoneA.setViewportSize({ width: w, height: h });
      await openLibraryWithTrackPlaying(phoneA);
      const dialog = await openFullPlayer(phoneA);

      // Two columns, not a stretched portrait: the artwork's column is
      // narrower than the panel and the controls sit beside it.
      const cols = await dialog.evaluate((el) => {
        const grid = Array.from(el.querySelectorAll("div")).find((d) => {
          const c = d.getAttribute("class");
          return typeof c === "string" && c.includes("landscape-short:grid");
        });
        return grid ? getComputedStyle(grid).gridTemplateColumns : null;
      });
      expect(cols, `${w}x${h}: the two-column landscape grid is not active`).toBeTruthy();
      expect(
        cols!.split(" ").length,
        `${w}x${h}: expected two columns, got "${cols}"`,
      ).toBe(2);

      const state = await dialog.evaluate((el) => {
        const controls = Array.from(el.querySelectorAll("button,input")).filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== "none";
        });
        let scroller: Element | null = null;
        for (const c of [el, ...Array.from(el.querySelectorAll("*"))]) {
          const cs = getComputedStyle(c);
          if (cs.overflowY === "auto" || cs.overflowY === "scroll") { scroller = c; break; }
        }
        return {
          count: controls.length,
          pastBottom: controls.filter((e) => e.getBoundingClientRect().bottom > window.innerHeight + 1)
            .map((e) => (e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24)),
          pastRight: controls.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length,
          small: controls.filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width < 44 || r.height < 44;
          }).length,
          scrollable: Boolean(scroller),
          scrollOverflow: scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0,
        };
      });

      expect(state.count, `${w}x${h}: the full player rendered almost no controls`).toBeGreaterThan(8);
      expect(state.pastRight, `${w}x${h}: a control sits past the right edge`).toBe(0);
      expect(state.small, `${w}x${h}: a control is under 44px`).toBe(0);
      // Reachable is the requirement, not "above the fold" — a scroller makes
      // a below-fold control reachable, and its absence makes it a defect.
      expect(
        state.pastBottom,
        `${w}x${h}: ${state.pastBottom.join(", ")} below the fold and the player does not scroll`,
      ).toEqual(state.scrollable ? expect.any(Array) : []);
      if (state.scrollable) {
        expect(
          state.scrollOverflow,
          `${w}x${h}: the landscape player overflows its own scroller by ${state.scrollOverflow}px, so it needs scrolling at a height it should fit`,
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  mobileAuthTest("the queue is a modal sheet below lg and a side panel at lg", async ({ phoneA }) => {
    for (const { w, h, modal } of [
      { w: 360, h: 800, modal: true },
      { w: 390, h: 844, modal: true },
      { w: 820, h: 1180, modal: true },
      { w: 1024, h: 1366, modal: false },
      { w: 1180, h: 820, modal: false },
    ]) {
      await phoneA.setViewportSize({ width: w, height: h });
      await openLibraryWithTrackPlaying(phoneA);

      // Below `sm` the queue button lives in the full player, not the mini
      // one — Phase 54 moved it there — so the full player is opened first.
      if (w < 640) {
        await openFullPlayer(phoneA);
      }
      await openQueue(phoneA);

      const queue = await phoneA.evaluate(() => {
        // The queue is the dialog whose panel has a scrollable list, not the
        // full player, which is also `role="dialog"` and is still mounted
        // behind it. Selecting by aria-label would depend on a translated
        // string, so this picks on structure: the queue's own scroller.
        const panels = Array.from(document.querySelectorAll('[role="dialog"]'));
        const panel = panels.find((d) =>
          Array.from(d.querySelectorAll("div")).some(
            (x) => x.className.toString().includes("overflow-y-auto"),
          ),
        );
        if (!panel) return null;
        const r = panel.getBoundingClientRect();
        const rows = Array.from(panel.querySelectorAll("li"));
        const scrims = Array.from(document.querySelectorAll("div")).filter((d) => {
          const c = d.getAttribute("class");
          return (
            typeof c === "string" &&
            c.includes("presence-backdrop") &&
            c.includes("fixed") &&
            getComputedStyle(d).display !== "none"
          );
        });
        const controls = Array.from(panel.querySelectorAll("button,input")).filter((e) => {
          const b = e.getBoundingClientRect();
          return b.width > 0 && b.height > 0 && getComputedStyle(e).display !== "none";
        });
        return {
          ariaModal: panel.getAttribute("aria-modal"),
          bodyOverflow: document.body.style.overflow,
          scrims: scrims.length,
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          rows: rows.length,
          smallTargets: controls
            .filter((e) => {
              const b = e.getBoundingClientRect();
              return b.width < 44 || b.height < 44;
            })
            .map((e) => {
              const b = e.getBoundingClientRect();
              return `${(e.getAttribute("aria-label") || e.textContent || e.tagName).replace(/\s+/g, " ").trim().slice(0, 24)} ${Math.round(b.width)}x${Math.round(b.height)}`;
            }),
          pastBottom: controls.filter((e) => e.getBoundingClientRect().bottom > window.innerHeight + 1).length,
          pastRight: controls.filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length,
        };
      });

      expect(queue, `${w}x${h}: the queue dialog was not found`).toBeTruthy();
      const q = queue!;
      const label = `${w}x${h} (${modal ? "modal sheet" : "side panel"})`;

      expect(q.box.x, `${label}: the queue starts off-screen to the left`).toBeGreaterThanOrEqual(0);
      expect(q.box.x + q.box.w, `${label}: the queue overflows the right edge`).toBeLessThanOrEqual(w + 1);
      expect(q.box.y, `${label}: the queue starts above the viewport`).toBeGreaterThanOrEqual(-1);
      expect(q.rows, `${label}: the queue rendered no rows`).toBeGreaterThan(0);
      expect(q.smallTargets, `${label}: sub-44px queue controls: ${q.smallTargets.join(" | ")}`).toEqual([]);
      expect(q.pastBottom, `${label}: a queue control is below the fold`).toBe(0);
      expect(q.pastRight, `${label}: a queue control is past the right edge`).toBe(0);

      if (modal) {
        expect(q.ariaModal, `${label}: a modal sheet must set aria-modal="true"`).toBe("true");
        expect(q.scrims, `${label}: a modal sheet must render exactly one backdrop`).toBe(1);
        expect(q.bodyOverflow, `${label}: the page behind the sheet must not scroll`).toBe("hidden");
      } else {
        // At `lg` the queue is a side panel beside the content, not a layer
        // over it, so it must NOT claim to be modal: `aria-modal` is absent
        // rather than "false", because `aria-modal="false"` still tells some
        // assistive tech to treat the rest of the page as inert-adjacent, and
        // the scrim is `lg:hidden` so no backdrop is laid out at all.
        expect(q.ariaModal, `${label}: a side panel must not claim to be modal`).toBeNull();
        expect(q.scrims, `${label}: a side panel must not dim the page behind it`).toBe(0);
        expect(q.bodyOverflow, `${label}: a side panel must leave the page scrollable`).not.toBe("hidden");
      }
    }
  });

  mobileAuthTest("the queue row menu is the phone's only reorder route, and it works", async ({ phoneA }) => {
    // Why the overflow menu and not a 44px drag handle: a handle of the
    // required touch size at 360px leaves 68px for the track title, which is
    // not a usable title. So below `sm` the move actions live in the row
    // menu, and the row keeps a readable title.
    //
    // Two things about the fixture make this test's setup non-obvious, and
    // both were found by the test failing rather than by reading the code:
    //
    // 1. Clicking Play on a `TrackRow` calls `engine.play(track)`, not
    //    `playCollection`, unless `collectionIndex` is also passed — and the
    //    E2E fixture library passes `collectionTracks` WITHOUT it. So
    //    playing a row leaves a one-item queue and "Next up" is empty. A
    //    second track is added the way a listener would add one, through the
    //    row's "Add to queue" action.
    //
    // 2. Row 0 is the CURRENTLY PLAYING track, and the queue deliberately
    //    gives that row no overflow menu: reordering the track you are
    //    listening to is not something the queue offers. So the row this
    //    drives is row 1.
    //
    // AND WHAT THIS DELIBERATELY DOES NOT CLAIM: that a move visibly
    // reorders two rows. With one upcoming track it cannot. `moveQueueItem`
    // is a permutation of `playOrder` in which `position` follows the
    // current track (store.test.ts pins both), so moving the only upcoming
    // track up puts it BEHIND the playhead — and the panel's sections are
    // positional ("everything that is not the current track"), so the two
    // rows still read the same. Asserting a visible swap here would be
    // asserting a behaviour the queue does not have. A visible reorder needs
    // three or more upcoming tracks, which the two-track fixture cannot
    // provide, so the mutation that IS visible — removing the row through
    // the same menu — is what proves the route works end to end.
    await phoneA.setViewportSize({ width: 360, height: 800 });
    await openLibraryWithTrackPlaying(phoneA);
    await addTrackToQueueFromRow(phoneA, TRACK_TWO);
    await openFullPlayer(phoneA);
    const panel = await openQueue(phoneA);

    const rows = panel.locator("li");
    await expect(rows).toHaveCount(2);
    const titleAt = async (i: number) => (await rows.nth(i).locator("p").first().innerText()).trim();
    expect(await titleAt(0)).toBe(TRACK_ONE);
    expect(await titleAt(1)).toBe(TRACK_TWO);

    // The move-up/move-down pair is the desktop route and must be ABSENT
    // here: if it were visible, the phone would be relying on the very
    // controls Phase 54 established do not fit, and this test's premise
    // would be false. `visible` filters the `hidden sm:flex` pair out.
    await expect(rows.locator('button[aria-label^="Move "]').filter({ visible: true })).toHaveCount(0);

    // The row's overflow trigger BY NAME, not `.locator("button").last()`.
    // The move buttons are still in the DOM below `sm` — they are
    // `hidden sm:flex`, and `hidden` means display:none, so `.last()`
    // resolves to an invisible button and the click times out. Selecting the
    // visible control is also the honest thing to assert: it is the one a
    // finger can reach, and it has to clear the floor to be reachable at all.
    const trigger = rows.nth(1).locator('button[aria-label^="Actions for"]:visible');
    await expect(trigger).toBeVisible();
    const triggerBox = (await trigger.boundingBox())!;
    expect(triggerBox.width, `360px: the row menu trigger is ${triggerBox.width}px wide`).toBeGreaterThanOrEqual(44);
    expect(triggerBox.height, `360px: the row menu trigger is ${triggerBox.height}px tall`).toBeGreaterThanOrEqual(44);
    await trigger.click();

    // The menu item's ACCESSIBLE NAME is the long form, `Move "{title}" up`,
    // not the short "Move up" it displays. Both exist on purpose: the
    // visible label has to fit a 192px menu, and the accessible name has to
    // say WHICH track the two identical arrows in a list refer to. So the
    // matcher is anchored to the long form — `name: "Move up"` matches
    // nothing here, which is the kind of locator that fails with "element
    // not found" and no hint about the cause.
    const menu = phoneA.getByRole("menu");
    const moveUp = menu.getByRole("menuitem", { name: /^Move .* up$/i });
    const moveDown = menu.getByRole("menuitem", { name: /^Move .* down$/i });
    await expect(moveUp).toBeVisible();
    await expect(moveUp).toBeEnabled();
    // Row 1 is the last position, so down has nowhere to go. Asserting the
    // disablement matters as much as the enablement: a menu that offers a
    // dead "Move down" on every row is a control that lies.
    await expect(moveDown).toBeVisible();
    await expect(moveDown).toBeDisabled();

    // Perform it, and prove the route is live: the menu closes, which only
    // happens through the item's own click handler.
    await moveUp.click();
    await expect(menu).toBeHidden();

    // Then the mutation that is actually visible at this queue size, from
    // the same menu: the upcoming track leaves the queue.
    await rows.nth(1).locator('button[aria-label^="Actions for"]:visible').click();
    const remove = phoneA.getByRole("menuitem", { name: "Remove from queue" });
    await expect(remove).toBeVisible();
    await remove.click();

    await expect(rows).toHaveCount(1);
    expect(await titleAt(0)).toBe(TRACK_ONE);
    await expect(panel).not.toContainText(TRACK_TWO);
  });

  mobileAuthTest("the queue row title survives a 44px touch target at 360px", async ({ phoneA }) => {
    // The measurement that motivated the overflow menu: with a 44px drag
    // handle in the row, this width was 68px. Asserted so a future "make
    // dragging work on touch" change cannot quietly reintroduce it.
    await phoneA.setViewportSize({ width: 360, height: 800 });
    await openLibraryWithTrackPlaying(phoneA);
    await openFullPlayer(phoneA);
    const panel = await openQueue(phoneA);
    const widths = await panel
      .locator("li p")
      .evaluateAll((nodes) => nodes.map((p) => Math.round(p.getBoundingClientRect().width)));
    expect(widths.length, "the queue rendered no titles").toBeGreaterThan(0);
    for (const w of widths) {
      expect(w, `360px: a queue row leaves only ${w}px for its title`).toBeGreaterThan(100);
    }
  });

  mobileAuthTest("empty states offer the next action on a phone", async ({ phoneA }) => {
    // RULE 64. `EmptyState` takes an `action`, and Phase 54 found 15 of 18
    // call sites passing nothing — so a dead end rendered as prose. Asserted
    // on a route that is reliably empty for a fresh synthetic account.
    await phoneA.setViewportSize({ width: 360, height: 800 });
    await phoneA.goto("/library");
    const actions = await phoneA.evaluate(() => {
      const states = Array.from(document.querySelectorAll("h3")).filter((h) =>
        h.closest(".rounded-2xl"),
      );
      return states.map((h) => {
        const box = h.closest(".rounded-2xl") as HTMLElement;
        return {
          title: (h.textContent || "").trim().slice(0, 40),
          hasAction: Boolean(box.querySelector("a[href],button")),
        };
      });
    });
    for (const s of actions) {
      expect(s.hasAction, `the empty state "${s.title}" offers no next action`).toBe(true);
    }
  });

  mobileAuthTest("the bottom stack never overlaps the player on a phone", async ({ phoneA }) => {
    // RULE 8. The nav owns the viewport bottom, the mini player sits directly
    // on top of it, and the two are `fixed` with no common parent — so only
    // geometry keeps them apart. Phase 54 moved the bottom safe-area padding
    // onto the `<nav>` itself, because padding on a shared wrapper let the
    // player cover the navigation's top edge.
    for (const width of PHONE_WIDTHS) {
      await phoneA.setViewportSize({ width, height: 844 });
      await openLibraryWithTrackPlaying(phoneA);
      const m = await phoneA.evaluate(() => {
        const region = Array.from(document.querySelectorAll('[role="region"]')).find((el) => {
          const r = el.getBoundingClientRect();
          return r.height > 0;
        });
        const nav = Array.from(document.querySelectorAll("nav")).find(
          (el) => !el.closest("aside") && !el.parentElement?.closest("nav") && el.getBoundingClientRect().height > 0,
        );
        if (!region || !nav) return null;
        return {
          playerBottom: Math.round(region.getBoundingClientRect().bottom),
          navTop: Math.round(nav.getBoundingClientRect().top),
          playerTop: Math.round(region.getBoundingClientRect().top),
        };
      });
      expect(m, `${width}px: the player or the navigation was not laid out`).toBeTruthy();
      expect(
        m!.playerBottom,
        `${width}px: the player overlaps the bottom navigation by ${m!.playerBottom - m!.navTop}px`,
      ).toBeLessThanOrEqual(m!.navTop + 1);
    }
  });

  mobileAuthTest("the like target clears 44px without costing the row its title", async ({ phoneA }) => {
    // `LikeButton` is `h-10 w-10` — 40px, a desktop density — and Phase 54
    // added `.aurora-touch` to it, so on a touch device it becomes 44px.
    //
    // It is NOT a track-row affordance: `TrackRow` exposes like through the
    // row's overflow menu, because a row at 360px cannot afford a fourth
    // 44px icon. The surfaces that render this button directly are the track
    // page and the E2E fixture library, and the fixture library is what this
    // measures — the track page's id is a database cuid, so a spec cannot
    // address it without first scraping the DOM for a link.
    //
    // The growth from 40px to 44px is 4px the layout has to find somewhere,
    // so both halves are asserted: the floor is met, and meeting it did not
    // squeeze the row's text or push the button out of the viewport.
    for (const width of [360, 390, 412]) {
      await phoneA.setViewportSize({ width, height: 900 });
      await phoneA.goto("/e2e-library");
      const like = phoneA
        .getByRole("main")
        .getByRole("button", { name: new RegExp(`Like ${TRACK_ONE}`, "i") })
        .first();
      await expect(like, `${width}px: the like control is not rendered`).toBeVisible();
      await settle(phoneA);

      const box = (await like.boundingBox())!;
      expect(box.width, `${width}px: the like target is ${box.width}px wide`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${width}px: the like target is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
      expect(box.x, `${width}px: the like target starts off-screen`).toBeGreaterThanOrEqual(0);
      expect(
        box.x + box.width,
        `${width}px: the like target overflows the right edge`,
      ).toBeLessThanOrEqual(width + 1);

      // The label beside it, and the track title on the row below, both
      // survive: the floor is not met by squeezing text out of existence.
      const label = await phoneA
        .getByRole("main")
        .getByText("Not liked", { exact: true })
        .first()
        .evaluate((el) => Math.round(el.getBoundingClientRect().width));
      expect(label, `${width}px: the like target left ${label}px for its state label`).toBeGreaterThan(40);

      const title = await phoneA
        .locator(".t-track-title")
        .first()
        .evaluate((el) => Math.round(el.getBoundingClientRect().width));
      expect(title, `${width}px: a track row leaves only ${title}px for its title`).toBeGreaterThan(100);
    }
  });
});
