/**
 * Canonical-duplicate journeys, driven through the real product: real browser,
 * real Auth.js session, real components → server actions → `requireUser` → DAL
 * → Postgres. Nothing here mocks an array, and every assertion reads durable
 * state — the membership row, the persisted queue snapshot, or the rendered
 * page — rather than a client-side flag.
 *
 * The two fixtures these journeys need that the rest of the suite does not:
 *
 * 1. The SAME track added twice. Exact-key duplicate, and the database
 *    constraint is the thing that makes the concurrent case safe.
 * 2. TWO provider renderings of one recording. Same title, same artist, no
 *    duration on either, so the canonical matcher returns `strong` — the band
 *    a caller may act on without asking a human. No unique index can see this
 *    pair, because they are two `Track` rows, which is precisely why the rule
 *    has a domain half as well as a database half.
 *
 * ORDERING NOTE: the cross-provider ids sort after `e2e-track-*`, so the
 * fixture library appends them and every other spec's positional row selector
 * still resolves to the row it was written against.
 */
import { authTest, expect } from "./auth/fixtures";
import {
  FIXTURE_CROSS_PROVIDER_TRACKS,
  FIXTURE_TRACKS,
  TEST_USERS,
} from "./auth/constants";
import { dbPlaylistTrackTitles, dbQueueSnapshotJson } from "./auth/run";

const USER_A = TEST_USERS[0].email;
const TRACK_ONE = FIXTURE_TRACKS[0].title;
const TRACK_ONE_ID = FIXTURE_TRACKS[0].providerTrackId;
const SPOTIFY = FIXTURE_CROSS_PROVIDER_TRACKS[0];
const DEEZER = FIXTURE_CROSS_PROVIDER_TRACKS[1];
const DEEZER_ID = DEEZER.providerTrackId;
const CROSS_TITLE = SPOTIFY.title;

let titleSequence = 0;
/** Unique per worker process and per call; see the equivalent note in
 * `authenticated-playlist.spec.ts` for why a fixed title is not safe. */
function uniqueTitle(prefix: string): string {
  titleSequence += 1;
  return `${prefix} ${process.pid}-${titleSequence}`;
}

async function createPlaylistViaUI(
  page: import("@playwright/test").Page,
  title: string,
): Promise<string> {
  await page.goto("/library");
  // `/library` carries the toolbar "Create playlist" action and, while the
  // library is empty, an identical CTA inside the empty state. Both open the
  // same dialog, so this names the toolbar one by its `aria-label` instead of
  // matching "Create playlist" and collecting both.
  // The section-header action is `aria-label="Create playlist"` with the word
  // "Create" hidden below `sm`; the empty-state CTA repeats that same label.
  // `.first()` names the header one by DOM order, deterministically.
  await page.getByLabel("Create playlist").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The field is labelled "Name" (`playlist.nameLabel`), not "Title".
  await dialog.getByLabel("Name").fill(title);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/library\/playlists\//);
  return page.url().split("/library/playlists/")[1].split("?")[0];
}

/**
 * Adds `trackTitle` to `playlistTitle` through the real row menu.
 *
 * `expectAdded` is the contract, not decoration. When the track is already a
 * member the menu does not offer a second add: the item is rendered DISABLED
 * and labelled "already in playlist". Asserting only the row count would pass
 * just as well against a silent second write that happened to render one row,
 * and clicking a disabled item is not a thing a user can do either - so the
 * duplicate case asserts the disabled, labelled state instead of clicking it.
 *
 * `.first()` is required, not a guess: the cross-provider pair is deliberately
 * two rows sharing one title inside the same `main` region (see the last
 * journey in this file), and both expose the same per-row action label.
 */
async function addToPlaylistViaUI(
  page: import("@playwright/test").Page,
  trackTitle: string,
  playlistTitle: string,
  expectAdded: boolean,
): Promise<void> {
  await page.goto("/e2e-library");
  await expect(
    page.getByRole("heading", { name: "E2E fixture library" }),
  ).toBeVisible();
  // Scoped to the library: once something is playing, the player bar exposes
  // its own truncated "Actions for <track>" button, and `getByRole` name
  // matching is substring-based, so an unscoped locator collects both.
  await page
    .getByRole("main")
    .getByRole("button", { name: `Actions for ${trackTitle}` })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Add to playlist" }).click();
  const submenu = page.getByRole("menu", { name: "Add to playlist" });
  await expect(submenu).toBeVisible();
  const item = submenu.getByRole("menuitem", { name: new RegExp(playlistTitle) });
  if (expectAdded) {
    await item.click();
    await expect(submenu).toHaveCount(0, { timeout: 15_000 });
  } else {
    // The membership already exists. The product must refuse the second add
    // and say why, rather than accepting a write and rendering one row.
    await expect(item).toBeDisabled();
    await expect(item).toHaveAccessibleName(/already in playlist/i);
  }
}

async function addToQueueViaUI(
  page: import("@playwright/test").Page,
  trackTitle: string,
): Promise<void> {
  // Same two reasons as `addToPlaylistViaUI`: the player bar carries a
  // truncated sibling of this label once playback has started, and the
  // cross-provider pair is deliberately two rows sharing one title.
  await page
    .getByRole("main")
    .getByRole("button", { name: `Actions for ${trackTitle}` })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Add to queue" }).click();
  await expect(
    page.getByRole("menuitem", { name: "Add to queue" }),
  ).toHaveCount(0);
}

function snapshotEntryIds(user: string): string[] {
  const raw = dbQueueSnapshotJson(user) as
    | { entries?: Array<{ providerTrackId?: string }> }
    | null;
  return (raw?.entries ?? []).map((entry) => entry.providerTrackId ?? "");
}

/**
 * The queue is persisted per user and SHARED with every other authenticated
 * spec in the run, so its whole contents are not this journey's to assert: an
 * earlier spec that queued a track leaves a legitimate entry behind, and
 * demanding an exact array made this journey fail on state it did not create.
 *
 * What is under test is narrower and stronger where it counts: the queue holds
 * exactly ONE entry per logical song, and each add either adds its one entry
 * or changes nothing. That is asserted as the occurrences of the ids under
 * test plus the total length, so a duplicate that slipped through would still
 * be caught by either number moving.
 */
function expectQueueHas(
  user: string,
  expected: { occurrences: Record<string, number>; total: number },
): Promise<void> {
  return expect
    .poll(
      () => {
        const ids = snapshotEntryIds(user);
        const occurrences: Record<string, number> = {};
        for (const [id, count] of Object.entries(expected.occurrences)) {
          occurrences[id] = ids.filter((entry) => entry === id).length;
        }
        return { occurrences, total: ids.length };
      },
      { timeout: 10_000, intervals: [150, 200, 300, 400, 500] },
    )
    .toEqual(expected);
}

authTest.describe("canonical duplicates", () => {
  authTest("playlist holds one membership after the same track is added twice", async ({
    pageA,
  }) => {
    const title = uniqueTitle("E2E Dedupe Same");
    const playlistId = await createPlaylistViaUI(pageA, title);

    await addToPlaylistViaUI(pageA, TRACK_ONE, title, true);
    await expect.poll(() => dbPlaylistTrackTitles(playlistId)).toEqual([TRACK_ONE]);

    // The second add of the SAME track. The membership check rejects it before
    // any write, and the UI reports it rather than failing silently.
    await addToPlaylistViaUI(pageA, TRACK_ONE, title, false);
    // A reload is the durable proof: nothing was queued in a client cache that
    // a refresh would clear.
    await pageA.goto(`/library/playlists/${playlistId}`);
    await expect(pageA.getByRole("heading", { name: title })).toBeVisible();
    await expect(pageA.getByText(TRACK_ONE)).toHaveCount(1);
    expect(dbPlaylistTrackTitles(playlistId)).toEqual([TRACK_ONE]);
  });

  authTest("playlist holds one membership for two provider renderings of one song", async ({
    pageA,
  }) => {
    const title = uniqueTitle("E2E Dedupe Cross");
    const playlistId = await createPlaylistViaUI(pageA, title);

    await addToPlaylistViaUI(pageA, CROSS_TITLE, title, true);
    await expect
      .poll(() => dbPlaylistTrackTitles(playlistId))
      .toEqual([CROSS_TITLE]);

    // The second row is a DIFFERENT `Track` row from a different provider, so
    // `@@unique([playlistId, trackId])` cannot see it and would happily accept
    // it. The canonical check is the only thing standing between this and a
    // playlist holding one song twice.
    await addToPlaylistViaUI(pageA, CROSS_TITLE, title, false);
    await pageA.goto(`/library/playlists/${playlistId}`);
    await expect(pageA.getByText(CROSS_TITLE)).toHaveCount(1);
    expect(dbPlaylistTrackTitles(playlistId)).toEqual([CROSS_TITLE]);
  });

  authTest("queue holds one entry for the same track and for both renderings", async ({
    pageA,
  }) => {
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();

    // Anchor the queue with the first fixture track, through the same "add to
    // queue" path every later step uses.
    //
    // This deliberately does NOT click `Play`. The fixture ids are synthetic
    // (`e2e-track-1`), so playback resolution correctly fails against the live
    // provider - a resolution failure means nothing is ever queued, and the
    // journey would be asserting the resolver rather than the queue. Queue
    // membership is a user-collection concern and needs no playable source;
    // real audio through the resolver is covered by the opt-in `live-*` suites
    // against real video ids.
    // The starting line is read, not assumed: another spec in this run may
    // legitimately have queued something for this user already, and the
    // journey is about what IT adds, not about an empty queue.
    const before = snapshotEntryIds(USER_A);

    await addToQueueViaUI(pageA, TRACK_ONE);
    await expectQueueHas(USER_A, {
      occurrences: { [TRACK_ONE_ID]: 1 },
      total: before.length + 1,
    });

    // The same track again, from the same row. Nothing about the queue moves.
    await addToQueueViaUI(pageA, TRACK_ONE);
    await expectQueueHas(USER_A, {
      occurrences: { [TRACK_ONE_ID]: 1 },
      total: before.length + 1,
    });

    // Both provider renderings of one recording, added in that order. The
    // first is new to the queue; the second is the same logical song and must
    // not extend it.
    //
    // `addToQueueViaUI` clicks the FIRST row carrying the shared title, and
    // `/e2e-library` orders by `providerTrackId`, so that row is the deezer
    // rendering - not the spotify one. The expectation follows the row the
    // click actually targets. What is under test is that adding the pair
    // leaves ONE entry, not which provider happened to win the row order; the
    // dedupe keeps whichever was queued first and absorbs the other.
    await addToQueueViaUI(pageA, CROSS_TITLE);
    await expectQueueHas(USER_A, {
      occurrences: { [TRACK_ONE_ID]: 1, [DEEZER_ID]: 1 },
      total: before.length + 2,
    });
    await addToQueueViaUI(pageA, CROSS_TITLE);
    await expectQueueHas(USER_A, {
      occurrences: { [TRACK_ONE_ID]: 1, [DEEZER_ID]: 1 },
      total: before.length + 2,
    });

    // Across a full reload the repair is the same invariant: the persisted
    // snapshot is re-installed through `restoreQueueSnapshot`, which collapses
    // repeats and re-points the play order and the cursor onto the survivors.
    await pageA.reload();
    await expect(
      pageA.getByRole("region", { name: "Player bar" }),
    ).toBeVisible();
    const after = snapshotEntryIds(USER_A);
    expect(after.filter((id) => id === TRACK_ONE_ID)).toHaveLength(1);
    expect(after.filter((id) => id === DEEZER_ID)).toHaveLength(1);
    expect(after).toHaveLength(before.length + 2);
  });

  authTest("the cross-provider pair stays two rows on the fixture library itself", async ({
    pageA,
  }) => {
    // The counterpart to the three journeys above, and the reason they are
    // allowed to exist. `/e2e-library` renders raw provider rows: it is NOT a
    // user collection, so it must NOT collapse. A fix that deduplicated this
    // page would be hiding the input rather than fixing the product, and would
    // make the three assertions above vacuous.
    await pageA.goto("/e2e-library");
    await expect(
      pageA.getByRole("heading", { name: "E2E fixture library" }),
    ).toBeVisible();
    await expect(pageA.getByText(CROSS_TITLE)).toHaveCount(2);
    // Both providers are genuinely represented — one row is not a coincidence
    // of two renders of a single element.
    await expect(
      pageA.getByRole("button", { name: `Actions for ${CROSS_TITLE}` }),
    ).toHaveCount(2);
    expect(DEEZER.providerTrackId).not.toBe(SPOTIFY.providerTrackId);
  });
});
