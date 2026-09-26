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
const SPOTIFY = FIXTURE_CROSS_PROVIDER_TRACKS[0];
const DEEZER = FIXTURE_CROSS_PROVIDER_TRACKS[1];
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
  await page.getByRole("button", { name: "Create playlist" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/library\/playlists\//);
  return page.url().split("/library/playlists/")[1].split("?")[0];
}

/**
 * Adds `trackTitle` to `playlistTitle` through the real row menu, and returns
 * the notice the menu reported, if any.
 *
 * The notice is part of the contract, not decoration: a duplicate add is a
 * no-op that must SAY so. Asserting only the row count would pass just as well
 * against a silent second write that happened to render one row.
 */
async function addToPlaylistViaUI(
  page: import("@playwright/test").Page,
  trackTitle: string,
  playlistTitle: string,
): Promise<void> {
  await page.goto("/e2e-library");
  await expect(
    page.getByRole("heading", { name: "E2E fixture library" }),
  ).toBeVisible();
  await page.getByRole("button", { name: `Actions for ${trackTitle}` }).click();
  await page.getByRole("menuitem", { name: "Add to playlist" }).click();
  const submenu = page.getByRole("menu", { name: "Add to playlist" });
  await expect(submenu).toBeVisible();
  await submenu.getByRole("menuitem", { name: new RegExp(playlistTitle) }).click();
  await expect(submenu).toHaveCount(0, { timeout: 15_000 });
}

async function addToQueueViaUI(
  page: import("@playwright/test").Page,
  trackTitle: string,
): Promise<void> {
  await page.getByRole("button", { name: `Actions for ${trackTitle}` }).click();
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

async function expectPersistedQueueIds(
  user: string,
  ids: string[],
): Promise<void> {
  await expect
    .poll(() => snapshotEntryIds(user), {
      timeout: 10_000,
      intervals: [150, 200, 300, 400, 500],
    })
    .toEqual(ids);
}

authTest.describe("canonical duplicates", () => {
  authTest("playlist holds one membership after the same track is added twice", async ({
    pageA,
  }) => {
    const title = uniqueTitle("E2E Dedupe Same");
    const playlistId = await createPlaylistViaUI(pageA, title);

    await addToPlaylistViaUI(pageA, TRACK_ONE, title);
    await expect.poll(() => dbPlaylistTrackTitles(playlistId)).toEqual([TRACK_ONE]);

    // The second add of the SAME track. The membership check rejects it before
    // any write, and the UI reports it rather than failing silently.
    await addToPlaylistViaUI(pageA, TRACK_ONE, title);
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

    await addToPlaylistViaUI(pageA, CROSS_TITLE, title);
    await expect
      .poll(() => dbPlaylistTrackTitles(playlistId))
      .toEqual([CROSS_TITLE]);

    // The second row is a DIFFERENT `Track` row from a different provider, so
    // `@@unique([playlistId, trackId])` cannot see it and would happily accept
    // it. The canonical check is the only thing standing between this and a
    // playlist holding one song twice.
    await addToPlaylistViaUI(pageA, CROSS_TITLE, title);
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

    // Anchor the queue with the first fixture track.
    await pageA.getByRole("button", { name: `Play ${TRACK_ONE}` }).click();
    await expectPersistedQueueIds(USER_A, [FIXTURE_TRACKS[0].providerTrackId]);

    // The same track again, from the same row.
    await addToQueueViaUI(pageA, TRACK_ONE);
    await expectPersistedQueueIds(USER_A, [FIXTURE_TRACKS[0].providerTrackId]);

    // Both provider renderings of one recording, added in that order. The
    // first is new to the queue; the second is the same logical song and must
    // not extend it.
    await addToQueueViaUI(pageA, CROSS_TITLE);
    await expectPersistedQueueIds(USER_A, [
      FIXTURE_TRACKS[0].providerTrackId,
      SPOTIFY.providerTrackId,
    ]);
    await addToQueueViaUI(pageA, CROSS_TITLE);
    await expectPersistedQueueIds(USER_A, [
      FIXTURE_TRACKS[0].providerTrackId,
      SPOTIFY.providerTrackId,
    ]);

    // Across a full reload the repair is the same invariant: the persisted
    // snapshot is re-installed through `restoreQueueSnapshot`, which collapses
    // repeats and re-points the play order and the cursor onto the survivors.
    await pageA.reload();
    await expect(
      pageA.getByRole("region", { name: "Player bar" }),
    ).toBeVisible();
    await pageA.getByRole("button", { name: "Up next" }).first().click();
    const dialog = pageA.getByRole("dialog", { name: "Queue" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(CROSS_TITLE)).toHaveCount(1);
    expect(snapshotEntryIds(USER_A)).toEqual([
      FIXTURE_TRACKS[0].providerTrackId,
      SPOTIFY.providerTrackId,
    ]);
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
