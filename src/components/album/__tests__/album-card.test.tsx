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

  it("links to providerAlbumId when available", () => {
    render(<AlbumCard album={makeAlbum({ providerAlbumId: "ext-al-99" })} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/album/ext-al-99");
  });

  it("falls back to internal id when providerAlbumId is missing", () => {
    render(<AlbumCard album={makeAlbum({ providerAlbumId: undefined })} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/album/al1");
  });
});
