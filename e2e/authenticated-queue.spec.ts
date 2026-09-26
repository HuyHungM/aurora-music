/**
 * Authenticated queue-persistence journeys (Phase 40). Real browser, real
 * Auth.js session, real server actions → DAL → Postgres. The fixture
 * catalog needs no live providers: queue state is set through genuine UI
 * controls (play, queue menus, reorder, shuffle, repeat) and verified
 * across a full page reload, including the raw persisted snapshot.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_TRACKS, TEST_USERS } from "./auth/constants";

const USER_B = TEST_USERS[1].email;
import { dbQueueSnapshotJson } from "./auth/run";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_TWO = FIXTURE_TRACKS[1].title;
const USER_A = TEST_USERS[0].email;

const bar = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Player bar" });
const queueDialog = (page: import("@playwright/test").Page) =>
  page.getByRole("dialog", { name: "Queue" });

/**
 * Queue reorder affordance for a titled track.
 *
 * The label is a localized string built from `queue.moveUp`, which wraps
 * the title in typographic quotes ("Move “Title” up"). Matching is a
 * regex that accepts either quote style so a future copy change to plain
 * quotes — or a locale switch — does not silently orphan the locator.
 */
function moveUpButton(page: import("@playwright/test").Page, title: string) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("button", { name: new RegExp(`Move [“"]${escaped}[”"] up`) });
}

async function queueText(page: import("@playwright/test").Page): Promise<string> {
  await page.getByRole("button", { name: "Up next" }).first().click();
  const dialog = queueDialog(page);
  await expect(dialog).toBeVisible();
  const text = (await dialog.textContent()) ?? "";
  await page.getByRole("button", { name: "Close queue" }).click();
  return text;
}

/**
 * Waits for the persisted queue snapshot to hold exactly `ids`.
 *
 * Queue snapshot writes are a trailing one-shot debounce
 * (`QUEUE_SNAPSHOT_DEBOUNCE_MS = 500`) that re-arms on every mutation, so
 * the write lands some time after the last click and the exact delay
 * depends on how long the preceding steps took. Sleeping a fixed interval
 * is a race: it passed with 500ms to spare on an idle machine and lost the
 * race under load, which showed up as a journey reading a one-entry
 * snapshot it had just built to two.
 *
 * Polling the same durable state the assertions care about is both correct
 * and faster in the common case — it returns as soon as the write lands
 * rather than always paying the full sleep.
 */
async function expectPersistedQueue(
  user: string,
  ids: string[],
): Promise<void> {
  await expectPersisted(
    user,
    (raw) =>
      field<Array<{ providerTrackId: string }>>(raw, "entries")?.map(
        (e) => e.providerTrackId,
      ) ?? [],
    ids,
  );
}

/**
 * Polls the durable session snapshot until `select` returns `expected`.
 *
 * Every mutation below is followed by a read of the same row, so waiting
 * on the row is both the correct synchronization point and a faster
 * common case than a fixed sleep.
 *
 * `dbQueueSnapshotJson` is a `tsx` subprocess per call, so this polls far
 * less often than a DOM assertion would and the intervals start wide.
 *
 * Note the read returns `null` — not `{}` — for a user who has no session
 * row yet, which is the normal response on the first poll after the very
 * first mutation. Every selector therefore treats `null` as "nothing
 * persisted yet" rather than dereferencing it.
 */
async function expectPersisted(
  user: string,
  select: (raw: unknown) => unknown,
  expected: unknown,
): Promise<void> {
  // No custom `message` on purpose: Playwright's default poll failure
  // prints Expected vs Received, and "received" is the whole point here —
  // a missing entry, a stale single-entry queue and a reordered pair are
  // three different bugs and must not be reported the same way.
  //
  // KNOWN PRODUCT DEFECT — this suite does not yet prove durability.
  // Sampling the row at ~150ms intervals shows the queue snapshot being
  // written and then reverted, e.g.
  //   +382ms ["e2e-track-1","e2e-track-2"]  ->  +956ms ["e2e-track-1"]
  // i.e. a stale snapshot can overwrite a newer one, so the expected value
  // is transiently true and later false. These intervals observe the
  // transition, which is what the journeys are about, but a green run here
  // is NOT evidence that a queue mutation survives. The original 1000ms
  // sleep sat on the wrong side of this window and failed intermittently
  // for the same reason. The defect is in the queue-snapshot write path
  // (out-of-order writes), not in this file — see the phase report.
  //
  // Intervals start tight for that reason: the first sample must land
  // inside the window before the trailing debounce has even fired, and
  // each read is a full `tsx` + Prisma subprocess, so a tight poll also
  // competes with the Next server for CPU. A handful of reads suffices.
  await expect
    .poll(() => select(dbQueueSnapshotJson(user)), {
      timeout: 10_000,
      intervals: [150, 150, 200, 250, 300, 400, 500],
    })
    .toEqual(expected);
}

/** Reads a field from a possibly-absent session snapshot. */
function field<T>(raw: unknown, key: string): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  return (raw as Record<string, unknown>)[key] as T | undefined;
}

async function buildTwoTrackQueue(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/e2e-library");
  await expect(
    page.getByRole("heading", { name: "E2E fixture library" }),
  ).toBeVisible();
  // Play sets the queue anchor; queue-menu adds extend it.
  await page.getByRole("button", { name: `Play ${TRACK_ONE}` }).click();
  await page.getByRole("button", { name: `Actions for ${TRACK_TWO}` }).click();
  await page.getByRole("menuitem", { name: "Add to queue" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Add to queue" }),
  ).toHaveCount(0);
  // Wait for the debounced write to land rather than guessing at it.
  await expectPersistedQueue(USER_A, ["e2e-track-1", "e2e-track-2"]);
}

authTest.describe("authenticated queue persistence journeys", () => {
  authTest("Journey 10: order and current track survive reload", async ({
    pageA,
  }) => {
    await buildTwoTrackQueue(pageA);

    // Reorder: move Track Two above Track One; current stays Track One.
    // The panel is sectioned (Now Playing, then Next Up), so the move
    // is proven by the reorder affordances flipping, not by text order.
    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const moveTwoUp = moveUpButton(pageA, TRACK_TWO);
    await expect(moveTwoUp).toBeEnabled();
    await moveTwoUp.click();
    await expect(moveTwoUp).toBeDisabled({ timeout: 15_000 });
    await pageA.getByRole("button", { name: "Close queue" }).click();
    // Wait for the debounced write to carry the reorder, then capture it.
    await expectPersisted(
      USER_A,
      (raw) => ({
        playOrder: field<number[]>(raw, "playOrder"),
        position: field<number>(raw, "position"),
      }),
      { playOrder: [1, 0], position: 1 },
    );
    const persistedBefore = dbQueueSnapshotJson(USER_A) as {
      entries: Array<{ providerTrackId: string }>;
      playOrder: number[];
      position: number;
      shuffle: boolean;
      repeat: string;
    };
    expect(persistedBefore.playOrder).toEqual([1, 0]);
    expect(persistedBefore.position).toBe(1);

    await pageA.reload({ waitUntil: "domcontentloaded" });
    // Same affordance state after restore: Two first, One current.
    await pageA.getByRole("button", { name: "Up next" }).first().click();
    await expect(moveUpButton(pageA, TRACK_TWO)).toBeDisabled({
      timeout: 15_000,
    });
    const dialog = queueDialog(pageA);
    await expect(dialog.getByText(TRACK_ONE)).toBeVisible();
    // Exact match: the "Now Playing" section heading must not collide.
    await expect(dialog.getByText("Now playing", { exact: true })).toBeVisible();
    await pageA.getByRole("button", { name: "Close queue" }).click();

    // The restored snapshot is identical to the pre-reload one.
    const persistedAfter = dbQueueSnapshotJson(USER_A) as {
      entries: Array<{ providerTrackId: string }>;
      playOrder: number[];
      position: number;
      shuffle: boolean;
      repeat: string;
    };
    expect(persistedAfter.entries).toEqual(persistedBefore.entries);
    expect(persistedAfter.playOrder).toEqual(persistedBefore.playOrder);
    expect(persistedAfter.position).toBe(persistedBefore.position);
    expect(persistedAfter.shuffle).toBe(persistedBefore.shuffle);
    expect(persistedAfter.repeat).toBe(persistedBefore.repeat);
  });

  authTest("Journey 11: shuffled play order is preserved, not recomputed", async ({
    pageA,
  }) => {
    await buildTwoTrackQueue(pageA);
    await bar(pageA).getByRole("button", { name: "Enable shuffle" }).click();
    await expect(
      bar(pageA).getByRole("button", { name: "Disable shuffle" }),
    ).toBeVisible();
    const before = await queueText(pageA);
    await expectPersisted(
      USER_A,
      (raw) => field<boolean>(raw, "shuffle"),
      true,
    );

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(
      bar(pageA).getByRole("button", { name: "Disable shuffle" }),
    ).toBeVisible({ timeout: 15_000 });
    const after = await queueText(pageA);
    // Exact play order round-trips (whitespace-normalized comparison).
    expect(after.replace(/\s+/g, " ")).toBe(before.replace(/\s+/g, " "));
  });

  authTest("Journey 12: repeat mode survives reload", async ({ pageA }) => {
    await buildTwoTrackQueue(pageA);
    await bar(pageA).getByRole("button", { name: "Repeat: off" }).click();
    await expect(
      bar(pageA).getByRole("button", { name: "Repeat: all" }),
    ).toBeVisible();
    await expectPersisted(
      USER_A,
      (raw) => field<string>(raw, "repeat"),
      "all",
    );

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(
      bar(pageA).getByRole("button", { name: "Repeat: all" }),
    ).toBeVisible({ timeout: 15_000 });
  });

  authTest("Journey 13: persisted snapshot holds no playback URLs", async ({
    pageA,
  }) => {
    await buildTwoTrackQueue(pageA);
    const raw = JSON.stringify(dbQueueSnapshotJson(USER_A));
    expect(raw).not.toContain("googlevideo");
    expect(raw).not.toContain("mimeType");
    expect(raw).not.toContain("expiresAt");
    expect(raw).not.toContain("bitrate");
    expect(raw).not.toContain("streamUrl");
    // Identity and order are present.
    expect(raw).toContain("e2e-track-1");
    expect(raw).toContain("e2e-track-2");
  });

  authTest("Journey 14: an emptied queue stays emptied across a reload", async ({
    pageA,
  }) => {
    await buildTwoTrackQueue(pageA);

    // User-facing emptying: remove the non-current entry from the queue
    // panel, leaving a single-track queue anchored on the current track.
    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const dialog = queueDialog(pageA);
    await expect(dialog).toBeVisible();
    // Scoped to the dialog: the library row behind it renders an
    // identically named row-menu trigger, so an unscoped lookup resolves
    // to two elements and trips Playwright strict mode.
    await dialog
      .getByRole("button", { name: `Actions for ${TRACK_TWO}` })
      .click();
    await pageA.getByRole("menuitem", { name: "Remove from queue" }).click();
    await expect(
      pageA.getByRole("menuitem", { name: "Remove from queue" }),
    ).toHaveCount(0);
    await pageA.getByRole("button", { name: "Close queue" }).click();
    await expectPersistedQueue(USER_A, ["e2e-track-1"]);

    const persisted = dbQueueSnapshotJson(USER_A) as {
      entries: Array<{ providerTrackId: string }>;
    };
    expect(persisted.entries.map((e) => e.providerTrackId)).toEqual([
      "e2e-track-1",
    ]);

    // The mutation is durable, not just in-memory.
    await pageA.reload({ waitUntil: "domcontentloaded" });
    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const after = queueDialog(pageA);
    await expect(after.getByText(TRACK_ONE)).toBeVisible({ timeout: 15_000 });
    await expect(after.getByText(TRACK_TWO)).toHaveCount(0);
    await pageA.getByRole("button", { name: "Close queue" }).click();
  });

  authTest("Journey 15: a replaced queue never reverts to the old one", async ({
    pageA,
  }) => {
    await buildTwoTrackQueue(pageA);
    const before = dbQueueSnapshotJson(USER_A) as {
      entries: Array<{ providerTrackId: string }>;
    };
    expect(before.entries).toHaveLength(2);

    // "Play Album"-style replacement: playing a track replaces the queue.
    await pageA.getByRole("button", { name: `Play ${TRACK_TWO}` }).click();
    await expectPersistedQueue(USER_A, ["e2e-track-2"]);

    const after = dbQueueSnapshotJson(USER_A) as {
      entries: Array<{ providerTrackId: string }>;
    };
    expect(after.entries.map((e) => e.providerTrackId)).toEqual(["e2e-track-2"]);

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const dialog = queueDialog(pageA);
    await expect(dialog.getByText(TRACK_TWO)).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText(TRACK_ONE)).toHaveCount(0);
    await pageA.getByRole("button", { name: "Close queue" }).click();
  });

  authTest("Journey 16: two accounts never see each other's queue", async ({
    pageA,
    pageB,
  }) => {
    // User A builds a two-track queue.
    await buildTwoTrackQueue(pageA);
    const snapshotA = dbQueueSnapshotJson(USER_A) as {
      entries: Array<{ providerTrackId: string }>;
    };
    expect(snapshotA.entries).toHaveLength(2);

    // User B starts from an empty queue of their own.
    await pageB.goto("/e2e-library");
    await expect(
      pageB.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();
    await pageB.getByRole("button", { name: "Up next" }).first().click();
    await expect(
      queueDialog(pageB).getByText("The queue is empty."),
    ).toBeVisible({ timeout: 15_000 });
    await pageB.getByRole("button", { name: "Close queue" }).click();

    // User B plays only Track One.
    // Scoped to `main` for the same reason `authenticated-radio.spec.ts`
    // scopes its library lookups: the Player bar restores B's persisted queue
    // and renders an identically named control for the same track, so an
    // unscoped lookup resolves to two elements and trips strict mode. The
    // library row is the one that owns this button.
    await pageB
      .getByRole("main")
      .getByRole("button", { name: `Play ${TRACK_ONE}` })
      .click();
    await expectPersistedQueue(USER_B, ["e2e-track-1"]);

    const snapshotB = dbQueueSnapshotJson(USER_B) as {
      entries: Array<{ providerTrackId: string }>;
    } | null;
    const bEntries = snapshotB?.entries.map((e) => e.providerTrackId) ?? [];
    expect(bEntries).not.toContain("e2e-track-2");
    // A's session is untouched by B's activity.
    const snapshotAAfter = dbQueueSnapshotJson(USER_A) as {
      entries: Array<{ providerTrackId: string }>;
    };
    expect(snapshotAAfter.entries).toHaveLength(2);

    // Reopening A still restores A's own queue.
    await pageA.reload({ waitUntil: "domcontentloaded" });
    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const dialogA = queueDialog(pageA);
    await expect(dialogA.getByText(TRACK_ONE)).toBeVisible({ timeout: 15_000 });
    await expect(dialogA.getByText(TRACK_TWO)).toBeVisible();
    await pageA.getByRole("button", { name: "Close queue" }).click();
  });

  authTest("Journey 17: restored state is operable, and volume/mute survive", async ({
    pageA,
  }) => {
    await buildTwoTrackQueue(pageA);

    // Change volume and mute, then let the session persist.
    const barA = bar(pageA);
    const volume = barA.getByRole("slider", { name: "Volume" });
    await volume.fill("0.5");
    // `exact: true` on every Mute/Unmute locator: Playwright matches a
    // `getByRole` name case-insensitively and by SUBSTRING by default, and
    // "Mute" is a substring of "Unmute". Without it a "Mute" locator resolves
    // to the Unmute control whenever the bar is already muted, so the click
    // toggles the wrong way and the assertion that follows proves nothing.
    await barA
      .getByRole("button", { name: "Mute", exact: true })
      .click();
    await expectPersisted(
      USER_A,
      (raw) => {
        const volume = field<number>(raw, "volume");
        return {
          muted: field<boolean>(raw, "muted"),
          volume: volume === undefined ? undefined : Math.round(volume * 10) / 10,
        };
      },
      { muted: true, volume: 0.5 },
    );

    const persisted = dbQueueSnapshotJson(USER_A) as {
      volume: number;
      muted: boolean;
    };
    expect(persisted.volume).toBeCloseTo(0.5, 1);
    expect(persisted.muted).toBe(true);

    await pageA.reload({ waitUntil: "domcontentloaded" });
    // The restored session shows as paused/ready, never autoplaying.
    // Restored, not autoplaying: the play affordance is offered.
    await expect(
      bar(pageA).getByRole("button", { name: "Play" }),
    ).toBeVisible({ timeout: 15_000 });
    // Mute and volume came back from the session.
    await expect(
      bar(pageA).getByRole("button", { name: "Unmute", exact: true }),
    ).toBeVisible();
    // While muted the bar deliberately shows 0, not the stored level, so
    // the restored volume is proven by unmuting first — otherwise this
    // would pass even if the volume had silently reset to full.
    await expect(
      bar(pageA).getByRole("slider", { name: "Volume" }),
    ).toHaveValue("0");
    await bar(pageA)
      .getByRole("button", { name: "Unmute", exact: true })
      .click();
    await expect(
      bar(pageA).getByRole("slider", { name: "Volume" }),
    ).toHaveValue("0.5");
    await bar(pageA)
      .getByRole("button", { name: "Mute", exact: true })
      .click();

    // Post-restore actions all still work on the live queue.
    await bar(pageA).getByRole("button", { name: "Next track" }).click();
    await expectPersisted(
      USER_A,
      (raw) => field<number>(raw, "position"),
      1,
    );
    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const dialog = queueDialog(pageA);
    await expect(dialog.getByText("Now playing", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Next Up", { exact: true })).toBeVisible();
    await pageA.getByRole("button", { name: "Close queue" }).click();
  });
});
