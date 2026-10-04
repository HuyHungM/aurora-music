// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AlbumCard } from "@/components/album/album-card";
import type { Album } from "@/lib/domain";

afterEach(() => {
  cleanup();
});

function makeAlbum(overrides: Partial<Album> = {}): Album {
  return {
    id: "al1",
    provider: "mock",
    title: "Test Album",
    artistId: "a1",
    artistName: "Test Artist",
    ...overrides,
  };
}

describe("AlbumCard", () => {
  it("renders album title", () => {
    render(<AlbumCard album={makeAlbum()} />);
    expect(screen.getByText("Test Album")).toBeTruthy();
  });

  it("renders artist name", () => {
    render(<AlbumCard album={makeAlbum()} />);
    expect(screen.getByText("Album · Test Artist")).toBeTruthy();
  });

  it("links to a provider-scoped id, so the route can ask the right provider", () => {
    // The href used to be the BARE providerAlbumId, which left `/album/[id]`
    // guessing which provider to ask. It guessed the preferred one, so every
    // album from any other provider 404'd. The provider now rides in the URL.
    render(<AlbumCard album={makeAlbum({ providerAlbumId: "ext-al-99" })} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/album/mock:ext-al-99");
  });

  it("falls back to the internal id, still provider-scoped, when providerAlbumId is missing", () => {
    render(<AlbumCard album={makeAlbum({ providerAlbumId: undefined })} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/album/mock:al1");
  });
});
