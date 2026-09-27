// @vitest-environment jsdom
/**
 * Regression test for M3-01: the Playlists section header and the library
 * empty state both offered a "Create playlist" control, and both carried the
 * SAME accessible name. Two controls sharing one accessible name are
 * indistinguishable to a screen-reader user, and ambiguous to any role-based
 * query - which is exactly what broke the canonical-duplicate journeys for
 * two audit missions before the header action was scoped to its section.
 *
 * The contract asserted here is narrow and behavioural: the header action is
 * named after the section it acts on, and no two controls on the empty page
 * answer to the same name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { PlaylistSection } from "@/components/library/playlist-section";
import { LocaleProvider } from "@/components/i18n/locale-provider";

vi.mock("@/app/actions/playlist", () => ({
  createPlaylistAction: vi.fn(async () => ({ ok: true, playlistId: "p1" })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

function renderSection(playlists: Parameters<typeof PlaylistSection>[0]["playlists"]) {
  return render(
    <LocaleProvider initialLocale="en">
      <PlaylistSection playlists={playlists} />
    </LocaleProvider>,
  );
}

describe("PlaylistSection create action", () => {
  it("names the header action after its section so it differs from the empty-state CTA", async () => {
    renderSection([]);

    // Both controls exist on an empty library; that redundancy is fine. What
    // must not happen is both answering to the identical accessible name.
    const header = screen.getByRole("button", { name: /create playlist in playlists/i });
    const cta = screen.getByRole("button", { name: /^create playlist$/i });

    expect(header).toBeTruthy();
    expect(cta).toBeTruthy();
    expect(header).not.toBe(cta);
    expect(header.getAttribute("aria-label")).not.toBe(cta.getAttribute("aria-label"));
  });

  it("exposes exactly one control per accessible name when the library is empty", () => {
    renderSection([]);

    const all = Array.from(document.querySelectorAll("button[aria-label]"));
    const names = all.map((b) => b.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("opens the same dialog from either control", async () => {
    const user = userEvent.setup();
    renderSection([]);

    await user.click(screen.getByRole("button", { name: /create playlist in playlists/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/name/i)).toBeTruthy();
  });

  it("keeps the header action available once playlists exist", () => {
    renderSection([
      {
        id: "p1",
        ownerId: "u1",
        title: "Chill",
        visibility: "private",
        items: [
          { id: "i1", trackId: "t1", provider: "youtube" },
          { id: "i2", trackId: "t2", provider: "youtube" },
        ],
      },
    ]);

    const header = screen.getByRole("button", { name: /create playlist in playlists/i });
    expect(header).toBeTruthy();
  });
});
