/**
 * Authenticated library + ownership journeys (Phase 30). Like/unlike
 * through the real LikeButton on the fixture library page, and the
 * cross-user ownership boundary through the real playlist route and
 * real DAL ownership checks. No mocks, no intercepted actions.
 */
import { authTest, expect } from "./auth/fixtures";
import { FIXTURE_ARTIST, FIXTURE_TRACKS, TEST_USERS } from "./auth/constants";
import { dbIsArtistFollowed, dbIsTrackLiked, dbPlaylistOwner } from "./auth/run";

const TRACK_ONE = FIXTURE_TRACKS[0].title;
const USER_A = TEST_USERS[0].email;

authTest.describe("authenticated library journeys", () => {
  authTest("Journey 6: like persists, unlike persists", async ({ pageA }) => {
    await pageA.goto("/e2e-library");
    // `exact: true` is load-bearing on every Like/Unlike and Follow/Unfollow
    // locator in this file. Playwright matches a `getByRole` name
    // case-insensitively and by SUBSTRING by default, so `Like X` also
    // matches `Unlike X`. These journeys branch on which toggle is currently
    // rendered, so a substring match silently targets the wrong control: the
    // test clicks the opposite action and then waits for the button it just
    // removed. It passes on a clean database and flakes on a dirty one.
    const like = pageA.getByRole("button", {
      name: `Like ${TRACK_ONE}`,
      exact: true,
    });
    const unlike = pageA.getByRole("button", {
      name: `Unlike ${TRACK_ONE}`,
      exact: true,
    });
    await expect(like.or(unlike).first()).toBeVisible();

    if (await like.isVisible()) {
      await like.click();
      await expect(unlike).toBeVisible({ timeout: 15_000 });
    }
    expect(dbIsTrackLiked(USER_A, "e2e-track-1")).toBe(true);

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(
      pageA.getByRole("button", {
        name: `Unlike ${TRACK_ONE}`,
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByText("Liked").first()).toBeVisible();

    await pageA
      .getByRole("button", {
        name: `Unlike ${TRACK_ONE}`,
        exact: true,
      })
      .click();
    await expect(
      pageA.getByRole("button", {
        name: `Like ${TRACK_ONE}`,
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });
    expect(dbIsTrackLiked(USER_A, "e2e-track-1")).toBe(false);

    await pageA.reload({ waitUntil: "domcontentloaded" });
    await expect(
      pageA.getByRole("button", {
        name: `Like ${TRACK_ONE}`,
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
  });

  authTest("Journey 7: user B cannot see or open user A's playlist", async ({
    pageA,
    pageB,
  }) => {
    // A creates a playlist and likes the fixture track.
    await pageA.goto("/library");
    await expect(
      pageA.getByRole("heading", { name: "Your Library" }),
    ).toBeVisible();
    await pageA
      .getByRole("button", { name: "Create playlist" })
      .first()
      .click();
    await pageA.getByLabel("Name").fill("E2E Ownership");
    await pageA.getByRole("button", { name: "Create", exact: true }).click();
    await pageA.waitForURL(/\/library\/playlists\/.+/);
    const playlistId = pageA.url().split("/library/playlists/")[1].split("?")[0];

    await pageA.goto("/e2e-library");
    const like = pageA.getByRole("button", {
      name: `Like ${TRACK_ONE}`,
      exact: true,
    });
    if (await like.isVisible()) {
      await like.click();
      await expect(
        pageA.getByRole("button", {
          name: `Unlike ${TRACK_ONE}`,
          exact: true,
        }),
      ).toBeVisible({ timeout: 15_000 });
    }

    // B's library never lists A's playlist: protected data isolation.
    await pageB.goto("/library");
    await expect(
      pageB.getByRole("heading", { name: "Your Library" }),
    ).toBeVisible();
    await expect(pageB.getByText("E2E Ownership")).toHaveCount(0);

    // B opening A's playlist URL hits the real ownership boundary:
    // requirePlaylistOwner → notFound, with no mutation controls.
    await pageB.goto(`/library/playlists/${playlistId}`);
    await expect(
      pageB.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      pageB.getByRole("button", { name: "Rename playlist" }),
    ).toHaveCount(0);
    await expect(
      pageB.getByRole("button", { name: "Delete playlist" }),
    ).toHaveCount(0);

    // The row still belongs to A: B's attempt changed nothing.
    expect(dbPlaylistOwner(playlistId)?.email).toBe(TEST_USERS[0].email);

    // Likes are per-user server state: B sees the same track unliked.
    await pageB.goto("/e2e-library");
    await expect(
      pageB.getByRole("button", {
        name: `Like ${TRACK_ONE}`,
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });
  });

  authTest("Journey 8: follow persists and surfaces in Library", async ({
    pageA,
    pageB,
  }) => {
    await pageA.goto("/e2e-library");
    const follow = pageA.getByRole("button", {
      name: `Follow ${FIXTURE_ARTIST.name}`,
      exact: true,
    });
    const unfollow = pageA.getByRole("button", {
      name: `Unfollow ${FIXTURE_ARTIST.name}`,
      exact: true,
    });
    await expect(follow.or(unfollow).first()).toBeVisible();

    if (await follow.isVisible()) {
      await follow.click();
      await expect(unfollow).toBeVisible({ timeout: 15_000 });
    }
    expect(dbIsArtistFollowed(USER_A)).toBe(true);

    // The Library Following Artists collection reflects the follow.
    await pageA.goto("/library");
    await expect(
      pageA.getByRole("heading", { name: "Your Library" }),
    ).toBeVisible();
    await expect(
      pageA.getByText(FIXTURE_ARTIST.name).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Follows are per-user server state: B sees the artist unfollowed.
    await pageB.goto("/e2e-library");
    await expect(
      pageB.getByRole("button", {
        name: `Follow ${FIXTURE_ARTIST.name}`,
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });
    expect(dbIsArtistFollowed(TEST_USERS[1].email)).toBe(false);

    // Unfollow persists and clears the Library collection entry.
    await pageA.goto("/e2e-library");
    await pageA
      .getByRole("button", {
        name: `Unfollow ${FIXTURE_ARTIST.name}`,
        exact: true,
      })
      .click();
    await expect(
      pageA.getByRole("button", {
        name: `Follow ${FIXTURE_ARTIST.name}`,
        exact: true,
      }),
    ).toBeVisible({ timeout: 15_000 });
    expect(dbIsArtistFollowed(USER_A)).toBe(false);

    await pageA.goto("/library");
    await expect(
      pageA.getByText("You aren't following any artists yet"),
    ).toBeVisible({ timeout: 15_000 });
  });
});
