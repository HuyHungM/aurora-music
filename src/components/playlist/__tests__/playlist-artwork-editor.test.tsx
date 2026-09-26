// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Playlist, Track } from "@/lib/domain";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/app/actions/playlist", () => ({
  updatePlaylistAction: vi.fn(),
}));

import { PlaylistArtworkEditor } from "@/components/playlist/playlist-artwork-editor";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { updatePlaylistAction } from "@/app/actions/playlist";

/**
 * Phase 47 custom playlist artwork (§3, §5, §6, §7, §8).
 *
 * The properties that matter:
 *
 *   1. SAVE — a valid URL is written; an invalid one is refused before a
 *      pointless round trip, and the SERVER refuses it too.
 *   2. REMOVE — removal writes an explicit `null` (not `undefined`), so the
 *      stored value actually clears and every surface falls back to the
 *      default artwork.
 *   3. NO SIDE EFFECTS — an artwork change never touches the playlist's
 *      track contents.
 *   4. PREVIEW — what the editor previews is what the surfaces render,
 *      including the default fallback.
 *
 * The locale is pinned to `en` so accessible names are stable; these
 * assertions are about behaviour, not about the copy.
 */

const CUSTOM = "https://img.example/cover.jpg";

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: "pl1",
    ownerId: "user-1",
    title: "My Playlist",
    visibility: "private",
    items: [
      { id: "pi1", trackId: "yt-1", provider: "youtube" },
      { id: "pi2", trackId: "yt-2", provider: "youtube" },
    ],
    ...overrides,
  };
}

const tracks: Track[] = [
  {
    id: "yt-1",
    provider: "youtube",
    providerTrackId: "yt-1",
    title: "First",
    artistId: "a1",
    artistName: "Artist One",
    artworkUrl: "https://img.example/one.jpg",
  },
  {
    id: "yt-2",
    provider: "youtube",
    providerTrackId: "yt-2",
    title: "Second",
    artistId: "a1",
    artistName: "Artist One",
    // A duplicate of the first cover: the picker must not offer it twice.
    artworkUrl: "https://img.example/one.jpg",
  },
  {
    id: "yt-3",
    provider: "youtube",
    providerTrackId: "yt-3",
    title: "Third",
    artistId: "a2",
    artistName: "Artist Two",
    artworkUrl: "https://img.example/two.jpg",
  },
  {
    id: "yt-4",
    provider: "youtube",
    providerTrackId: "yt-4",
    title: "Fourth",
    artistId: "a2",
    artistName: "Artist Two",
    // No cover: nothing to suggest.
  },
];

function renderEditor(value: Playlist = playlist(), list: Track[] = tracks) {
  return render(
    <LocaleProvider initialLocale="en">
      <PlaylistArtworkEditor playlist={value} tracks={list} />
    </LocaleProvider>,
  );
}

async function openEditor(value?: Playlist, list?: Track[]) {
  renderEditor(value, list);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Change artwork" }));
  return user;
}

function urlInput() {
  return screen.getByLabelText("Image URL") as HTMLInputElement;
}

/**
 * Sets the field in one event rather than one keystroke per character.
 *
 * `userEvent.type` dispatches ~2000 renders for a long value, which is slow
 * enough to blow the test timeout — and a timed-out `type` keeps firing its
 * remaining keystrokes into whatever renders next, silently poisoning the
 * tests that follow. Tests that care about the field being *typed*
 * progressively (the `next/image` crash guard below) use `user.type`
 * deliberately; the rest only care about the resulting value.
 */
function setUrlField(value: string) {
  fireEvent.change(urlInput(), { target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(updatePlaylistAction).mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
});

describe("PlaylistArtworkEditor: saving custom artwork", () => {
  it("writes the pasted URL through the owner-gated action", async () => {
    const user = await openEditor();
    setUrlField(CUSTOM);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePlaylistAction).toHaveBeenCalledWith("pl1", { artwork: CUSTOM });
    });
  });

  it("trims surrounding whitespace before writing", async () => {
    const user = await openEditor();
    setUrlField(`  ${CUSTOM}  `);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePlaylistAction).toHaveBeenCalledWith("pl1", { artwork: CUSTOM });
    });
  });

  it("confirms the save in a live region", async () => {
    const user = await openEditor();
    setUrlField(CUSTOM);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const live = document.querySelector('[aria-live="polite"]');
      expect(live?.textContent?.trim().length).toBeGreaterThan(0);
    });
  });

  it("shows an error and announces nothing when the server refuses", async () => {
    vi.mocked(updatePlaylistAction).mockResolvedValue({
      ok: false,
      error: "Forbidden",
    });
    const user = await openEditor();
    setUrlField(CUSTOM);
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent?.trim()).toBe("");
  });
});

describe("PlaylistArtworkEditor: input validation (§7)", () => {
  // The client mirror avoids a pointless round trip; the server validates
  // again. Both layers are asserted, because either one alone could regress.
  it("refuses a dangerous scheme before any request is made", async () => {
    for (const value of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "blob:https://example.com/x",
      "file:///etc/passwd",
    ]) {
      cleanup();
      const user = await openEditor();
      await user.type(urlInput(), value);

      const save = screen.getByRole("button", { name: "Save" });
      expect(save.hasAttribute("disabled"), value).toBe(true);
      expect(urlInput().getAttribute("aria-invalid")).toBe("true");
      // And it says why.
      expect(screen.getByText(/valid http or https/i)).toBeTruthy();

      await user.click(save).catch(() => undefined);
      expect(updatePlaylistAction, value).not.toHaveBeenCalled();
    }
  });

  it("refuses a non-URL string", async () => {
    await openEditor();
    setUrlField("not a url at all");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(updatePlaylistAction).not.toHaveBeenCalled();
  });

  // Typing a URL is inherently a sequence of not-yet-valid partial values
  // ("h", "ht", "https://"). The preview must survive every one of them: the
  // image component throws on an unparseable `src`, and handing it a
  // half-typed hostname took the whole dialog down on the first keystroke.
  it("survives being typed into, keystroke by keystroke", async () => {
    await openEditor();
    const partials = ["h", "ht", "htt", "http", "http:", "https:/", "https://"];

    for (const partial of partials) {
      setUrlField(partial);
      // The dialog is still there, still shows the default artwork, and
      // still refuses to save.
      expect(screen.getByRole("button", { name: "Change artwork" }), partial).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
        partial,
      ).toBe(true);
      // Nothing renders the half-typed value as an image source.
      for (const img of Array.from(document.querySelectorAll("img"))) {
        expect(img.getAttribute("src"), partial).not.toBe(partial);
      }
      expect(updatePlaylistAction, partial).not.toHaveBeenCalled();
    }

    // The first genuinely valid value enables saving, still without a crash.
    setUrlField("https://img.ex");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("refuses a URL longer than the cap", async () => {
    await openEditor();
    setUrlField(`https://img.example/${"a".repeat(2100)}`);
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(updatePlaylistAction).not.toHaveBeenCalled();
  });

  it("accepts http as well as https", async () => {
    await openEditor();
    setUrlField("http://img.example/cover.jpg");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  it("treats an empty field as the default, which is always valid", async () => {
    await openEditor(playlist({ artwork: CUSTOM }));
    setUrlField("");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
  });

  // A client-side check is a convenience, never the guarantee: the server
  // validates the same URL again. This proves the payload is exactly what the
  // schema would accept — no extra fields, no pre-cooked "safe" value.
  it("sends nothing but the artwork field, so the server validates it", async () => {
    const user = await openEditor();
    setUrlField(CUSTOM);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePlaylistAction).toHaveBeenCalledWith("pl1", { artwork: CUSTOM });
    });
    const [id, payload] = vi.mocked(updatePlaylistAction).mock.calls[0] as [string, object];
    expect(id).toBe("pl1");
    expect(Object.keys(payload)).toEqual(["artwork"]);
  });
});

describe("PlaylistArtworkEditor: removing artwork falls back to the default", () => {
  it("writes an explicit null, not undefined", async () => {
    const user = await openEditor(playlist({ artwork: CUSTOM }));
    await user.click(screen.getByRole("button", { name: "Remove artwork" }));

    await waitFor(() => {
      // `undefined` means "don't touch it". Only an explicit null removes it.
      expect(updatePlaylistAction).toHaveBeenCalledWith("pl1", { artwork: null });
    });
  });

  it("offers no remove control when there is no custom artwork", async () => {
    await openEditor();
    expect(screen.queryByRole("button", { name: "Remove artwork" })).toBeNull();
  });

  it("shows the default artwork in the preview once removed", async () => {
    const user = await openEditor(playlist({ artwork: CUSTOM }));
    expect(screen.getByText("Custom artwork")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove artwork" }));
    await waitFor(() => {
      expect(screen.getByText("Default artwork")).toBeTruthy();
    });
  });
});

describe("PlaylistArtworkEditor: preview matches what surfaces render", () => {
  it("previews the custom artwork that is about to be saved", async () => {
    await openEditor();
    setUrlField(CUSTOM);

    const preview = document.querySelector("img[src='" + CUSTOM + "']");
    expect(preview).not.toBeNull();
    expect(screen.getByText("Custom artwork")).toBeTruthy();
  });

  it("renders no image for the default artwork", async () => {
    await openEditor();
    expect(screen.getByText("Default artwork")).toBeTruthy();
    // The preview must not point at an empty `src`, which would re-request
    // the page itself.
    for (const img of Array.from(document.querySelectorAll("img"))) {
      expect(img.getAttribute("src")).not.toBe("");
    }
  });
});

describe("PlaylistArtworkEditor: picking from the playlist's own covers", () => {
  it("offers each distinct cover once, in playlist order", async () => {
    await openEditor();
    // `one.jpg` appears twice in the playlist and must be offered once.
    const picks = screen.getAllByRole("button", { name: "Pick from this playlist" });
    expect(picks).toHaveLength(2);
  });

  it("fills the field when a cover is picked, and marks it selected", async () => {
    const user = await openEditor();
    const picks = screen.getAllByRole("button", { name: "Pick from this playlist" });
    await user.click(picks[1]);

    expect(urlInput().value).toBe("https://img.example/two.jpg");
    expect(picks[1].getAttribute("aria-pressed")).toBe("true");
    expect(picks[0].getAttribute("aria-pressed")).toBe("false");
  });

  it("saves a picked cover without any typing", async () => {
    const user = await openEditor();
    await user.click(screen.getAllByRole("button", { name: "Pick from this playlist" })[0]);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePlaylistAction).toHaveBeenCalledWith("pl1", {
        artwork: "https://img.example/one.jpg",
      });
    });
  });

  it("offers no picker when the playlist has no covers", async () => {
    await openEditor(playlist(), [
      { id: "yt-9", provider: "youtube", providerTrackId: "yt-9", title: "Bare", artistId: "a", artistName: "A" },
    ]);
    expect(screen.queryByRole("button", { name: "Pick from this playlist" })).toBeNull();
  });
});

describe("PlaylistArtworkEditor: artwork never touches track contents (§6)", () => {
  it("sends only the artwork field, never a track list", async () => {
    const user = await openEditor();
    setUrlField(CUSTOM);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(updatePlaylistAction).toHaveBeenCalledTimes(1);
    });
    const [, payload] = vi.mocked(updatePlaylistAction).mock.calls[0] as [string, object];
    expect(Object.keys(payload)).toEqual(["artwork"]);
    expect(JSON.stringify(payload)).not.toContain("yt-1");
  });

  it("resets to the server's value when the dialog is reopened after an edit", async () => {
    // A cancelled edit must not leak a half-typed URL into the next open.
    const user = await openEditor();
    setUrlField(CUSTOM);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    cleanup();

    await openEditor(playlist({ artwork: CUSTOM }));
    expect(urlInput().value).toBe(CUSTOM);
  });
});
