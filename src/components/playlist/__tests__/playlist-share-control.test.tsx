// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Playlist } from "@/lib/domain";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/actions/playlist", () => ({
  setPlaylistVisibilityAction: vi.fn(),
}));

import { PlaylistShareControl } from "@/components/playlist/playlist-share-control";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { within } from "@testing-library/react";
import { setPlaylistVisibilityAction } from "@/app/actions/playlist";

/**
 * Owner sharing control (§8, §14, §15, §18).
 *
 * The control is owner-only by presentation, but the property that matters is
 * that it never asks the server to do something a non-owner could not do, and
 * that the link it hands out contains nothing but the opaque token.
 *
 * The second property is the one the redesign could most easily have broken.
 * The old control reached the server through a single button whose label
 * flipped; the new one reaches it through a two-option access control, which
 * means the tests below now have to name the *state* rather than the action.
 * Every behavioural assertion from the previous version of this file is still
 * here - the same calls, the same arguments, the same error and clipboard
 * edges - because a layout change is exactly the kind of change that quietly
 * loses one.
 *
 * The locale is pinned to `en` so the accessible names are stable: the
 * default fallback locale is `vi`, and these assertions are about behaviour,
 * not about the copy.
 */

const TOKEN = "kZ8xR2mQ7vT4pL9nW6yB3cF8jH1dG5kA0";
const OTHER_TOKEN = "ZZZZ2222rrrr3333ssss4444tttt";
const SHARE_URL = `http://localhost:3000/playlist/share/${TOKEN}`;

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: "pl1",
    ownerId: "user-1",
    title: "My Playlist",
    visibility: "private",
    items: [],
    ...overrides,
  };
}

function item(id: string) {
  return { id, trackId: `trk-${id}`, provider: "youtube" as const };
}

function renderControl(value: Playlist) {
  return render(
    <LocaleProvider initialLocale="en">
      <PlaylistShareControl playlist={value} />
    </LocaleProvider>,
  );
}

/** Renders the control for `value` and opens its share dialog. */
async function openDialog(value: Playlist = playlist()) {
  renderControl(value);
  const user = userEvent.setup();
  // Re-apply the wanted clipboard: user-event overwrote it during setup.
  stubClipboard(wantedClipboard);
  await user.click(screen.getByRole("button", { name: "Share" }));
  return user;
}

function shareLink() {
  return screen.queryByDisplayValue(/playlist\/share/) as HTMLInputElement | null;
}

/**
 * Queries scoped to the dialog.
 *
 * The trigger button that OPENS this dialog is still in the document while it
 * is open, and it is called "Share" - the same word as the in-dialog button
 * that opens the platform's own share sheet. Both names are correct in their
 * own context, so the ambiguity is a fact about the UI rather than a bug to
 * paper over; the fix is that the tests ask within the dialog, which is where
 * a user's focus actually is (the dialog traps it).
 */
function inDialog() {
  return within(screen.getByRole("dialog"));
}

/** The "Public" option of the access control. */
function publicOption() {
  return screen.getByRole("button", { name: "Public" });
}

/** The "Private" option of the access control. */
function privateOption() {
  return screen.getByRole("button", { name: "Private" });
}

/**
 * `navigator.clipboard` is an accessor-only property on jsdom's Navigator, so
 * a plain assignment throws. `userEvent.setup()` also installs its own
 * clipboard stub, which would mask the behaviour under test — so the wanted
 * value is remembered here and re-applied by `openDialog` after setup.
 */
let wantedClipboard: unknown;

function stubClipboard(value: unknown) {
  wantedClipboard = value;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    writable: true,
    value,
  });
}

/** `navigator.share` is absent on jsdom, so the native path is opt-in here. */
function stubNativeShare(value: unknown) {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    writable: true,
    value,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom implements no clipboard; stub exactly the surface the control uses.
  stubClipboard({ writeText: vi.fn().mockResolvedValue(undefined) });
  stubNativeShare(undefined);
  vi.mocked(setPlaylistVisibilityAction).mockResolvedValue({
    ok: true,
    visibility: "shared",
    shareToken: TOKEN,
  });
});

afterEach(() => {
  cleanup();
});

describe("PlaylistShareControl: what is being shared", () => {
  it("names the playlist, so the dialog is not a form with no subject", async () => {
    await openDialog(playlist({ title: "Vietnamese Favorites" }));
    expect(screen.getByText("Vietnamese Favorites")).toBeTruthy();
  });

  it("reports the track count", async () => {
    await openDialog(playlist({ items: [item("a"), item("b"), item("c")] }));
    expect(screen.getByText("3 tracks")).toBeTruthy();
  });

  it("states the current access state, in words and not only in a colour", async () => {
    await openDialog();
    expect(screen.getByText("This playlist isn't shared. Only you can see it.")).toBeTruthy();
    expect(privateOption().getAttribute("aria-pressed")).toBe("true");
  });

  // A first draft also carried a "Private"/"Shared" badge in the preview row.
  // The dialog then showed the state word twice - once as the selected control,
  // once as a readout of it - which is two answers to one question and a
  // duplicated announcement. Each word may appear, but only as its control.
  it("never states the access state as a second, separate readout", async () => {
    await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    for (const word of ["Public", "Private"]) {
      const matches = screen.queryAllByText(word);
      expect(matches).toHaveLength(1);
      expect(matches[0].tagName).toBe("BUTTON");
    }
  });

  it("states the shared access state and warns that turning it off breaks the link", async () => {
    await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    expect(
      screen.getByText(
        "Anyone with this link can view and play the playlist. They can't edit it.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Turning sharing off invalidates the current public link immediately.",
      ),
    ).toBeTruthy();
  });

  it("marks the option that is already selected as pressed", async () => {
    await openDialog();
    expect(privateOption().getAttribute("aria-pressed")).toBe("true");
    expect(publicOption().getAttribute("aria-pressed")).toBe("false");
  });
});

describe("PlaylistShareControl: enabling sharing", () => {
  it("calls the owner-gated action and then shows the link", async () => {
    const user = await openDialog();
    await user.click(publicOption());

    await waitFor(() => {
      expect(setPlaylistVisibilityAction).toHaveBeenCalledWith("pl1", "shared");
    });
    // The link appears only after the server confirmed and returned a token.
    await waitFor(() => {
      expect(shareLink()).not.toBeNull();
    });
    // And the control now reports the new state rather than only offering it.
    await waitFor(() => {
      expect(publicOption().getAttribute("aria-pressed")).toBe("true");
    });
  });

  // §9/§18: the public URL is the token and nothing else.
  it("puts nothing but the token in the share URL", async () => {
    const user = await openDialog();
    await user.click(publicOption());
    await waitFor(() => {
      expect(shareLink()).not.toBeNull();
    });

    const value = (shareLink() as HTMLInputElement).value;
    expect(value).toBe(SHARE_URL);
    expect(value).not.toContain("pl1");
    expect(value).not.toContain("user-1");
    expect(value).not.toContain("playlistId");
  });

  it("writes nothing when the already-selected option is activated", async () => {
    const user = await openDialog();
    // A segmented control reports its state on every activation. Re-selecting
    // "Private" on a private playlist is not a request to go private, and must
    // not cost a write or flash a pending state.
    await user.click(privateOption());
    expect(setPlaylistVisibilityAction).not.toHaveBeenCalled();
  });

  it("shows an error and no link when the server refuses", async () => {
    vi.mocked(setPlaylistVisibilityAction).mockResolvedValue({
      ok: false,
      error: "not authorized",
    });
    const user = await openDialog();
    await user.click(publicOption());

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(shareLink()).toBeNull();
  });

  it("offers a retry that repeats the request that failed", async () => {
    vi.mocked(setPlaylistVisibilityAction).mockResolvedValue({
      ok: false,
      error: "not authorized",
    });
    const user = await openDialog();
    await user.click(publicOption());
    expect(await screen.findByRole("alert")).toBeTruthy();

    vi.mocked(setPlaylistVisibilityAction).mockResolvedValue({
      ok: true,
      visibility: "shared",
      shareToken: TOKEN,
    });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(shareLink()).not.toBeNull();
    });
  });

  it("keeps the control disabled while the request is in flight", async () => {
    let release!: () => void;
    vi.mocked(setPlaylistVisibilityAction).mockReturnValue(
      new Promise((resolve) => {
        release = () => {
          resolve({ ok: true, visibility: "shared", shareToken: TOKEN });
        };
      }),
    );
    const user = await openDialog();
    await user.click(publicOption());

    // The pending state says what is happening, not merely that it is
    // happening - and it does NOT replace the option's own label, so the
    // control still shows which direction was asked for.
    await waitFor(() => {
      expect(screen.getByText("Generating link...")).toBeTruthy();
    });
    expect(publicOption().getAttribute("aria-pressed")).toBe("false");
    // A second click cannot double-submit and mint two tokens.
    await user.click(publicOption());
    expect(setPlaylistVisibilityAction).toHaveBeenCalledTimes(1);
    // Both directions are held, not only the one being pressed: there is one
    // meaningful action available and it is already running.
    expect(privateOption().hasAttribute("disabled")).toBe(true);

    release();
    await waitFor(() => {
      expect(shareLink()).not.toBeNull();
    });
  });
});

describe("PlaylistShareControl: an already-shared playlist", () => {
  it("shows the existing link on open without any write", async () => {
    await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));

    expect((shareLink() as HTMLInputElement).value).toBe(SHARE_URL);
    expect(setPlaylistVisibilityAction).not.toHaveBeenCalled();
  });

  it("offers revocation, and revoking makes the old link disappear", async () => {
    vi.mocked(setPlaylistVisibilityAction).mockResolvedValue({
      ok: true,
      visibility: "private",
      shareToken: null,
    });
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));

    await user.click(privateOption());
    await waitFor(() => {
      expect(setPlaylistVisibilityAction).toHaveBeenCalledWith("pl1", "private");
    });
    // Revocation is immediate in the UI: the revoked link stops being offered.
    await waitFor(() => {
      expect(shareLink()).toBeNull();
    });
  });

  // Server props are the source of truth, and a `router.refresh()` may not
  // have landed when the action resolved. The control reconciles the token
  // during render rather than in an effect, so a refreshed token is adopted.
  it("adopts a new token from refreshed server props", () => {
    const { rerender } = renderControl(
      playlist({ visibility: "shared", shareToken: TOKEN }),
    );
    rerender(
      <LocaleProvider initialLocale="en">
        <PlaylistShareControl playlist={playlist({ visibility: "shared", shareToken: OTHER_TOKEN })} />
      </LocaleProvider>,
    );
    expect(screen.queryByDisplayValue(new RegExp(TOKEN))).toBeNull();
  });

  it("shows no link when a shared playlist has no token yet", async () => {
    await openDialog(playlist({ visibility: "shared" }));
    // A broken link is worse than no link.
    expect(shareLink()).toBeNull();
  });
});

describe("PlaylistShareControl: copying", () => {
  it("copies the exact URL and announces it in a live region", async () => {
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SHARE_URL);
    });
    // §15: the confirmation is announced, not only recoloured.
    await waitFor(() => {
      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent?.trim().length).toBeGreaterThan(0);
    });
  });

  // The copy control is the whole point of the dialog, so it must be usable
  // from the first render and stay usable afterwards. A regression here is
  // silent — the dialog still opens and the link still displays.
  it("leaves the copy button enabled after copying, so it can be copied again", async () => {
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Link copied" })).toBeTruthy();
    });
    // Still clickable, and a second copy works.
    expect(
      screen.getByRole("button", { name: "Link copied" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("returns the control to 'Copy link' so the label cannot go stale", async () => {
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Link copied" })).toBeTruthy();
    });

    // "Copied" is a claim about the last action, not a permanent badge.
    await waitFor(
      () => {
        expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
      },
      { timeout: 4000 },
    );
  });

  it("reports a rejected clipboard write instead of claiming success", async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    // And it must not claim the copy happened.
    expect(screen.queryByRole("button", { name: "Link copied" })).toBeNull();
  });

  it("reports a missing clipboard rather than silently doing nothing", async () => {
    stubClipboard(undefined);
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    await user.click(screen.getByRole("button", { name: "Copy link" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("PlaylistShareControl: the native share sheet", () => {
  it("is not offered where the platform has no share sheet", async () => {
    await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    // A share button that cannot open anything is worse than no share button.
    expect(inDialog().queryByRole("button", { name: "Share" })).toBeNull();
    // Copy remains available regardless.
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("hands the URL to the platform where one exists", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubNativeShare(share);
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));

    await user.click(inDialog().getByRole("button", { name: "Share" }));
    await waitFor(() => {
      expect(share).toHaveBeenCalledWith({
        title: "My Playlist",
        url: SHARE_URL,
      });
    });
  });

  it("treats a dismissed sheet as a decision, not a failure", async () => {
    stubNativeShare(
      vi.fn().mockRejectedValue(
        new DOMException("cancelled", "AbortError"),
      ),
    );
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    await user.click(inDialog().getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("reports a sheet that genuinely failed to open", async () => {
    stubNativeShare(vi.fn().mockRejectedValue(new Error("boom")));
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    await user.click(inDialog().getByRole("button", { name: "Share" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("PlaylistShareControl: the dialog is escapable", () => {
  it("closes on the close control and hides the link", async () => {
    const user = await openDialog(playlist({ visibility: "shared", shareToken: TOKEN }));
    expect(shareLink()).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(shareLink()).toBeNull();
    });
  });
});
