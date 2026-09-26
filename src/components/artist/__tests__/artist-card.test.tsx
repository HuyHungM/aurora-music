// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ArtistCard } from "@/components/artist/artist-card";
import type { Artist } from "@/lib/domain";

afterEach(() => {
  cleanup();
});

function makeArtist(overrides: Partial<Artist> = {}): Artist {
  return {
    id: "a1",
    provider: "mock",
    name: "Test Artist",
    ...overrides,
  };
}

describe("ArtistCard", () => {
  it("renders artist name", () => {
    render(<ArtistCard artist={makeArtist()} />);
    expect(screen.getByText("Test Artist")).toBeTruthy();
  });

  it("links to providerArtistId when available", () => {
    render(<ArtistCard artist={makeArtist({ providerArtistId: "ext-42" })} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/artist/ext-42");
  });

  it("falls back to internal id when providerArtistId is missing", () => {
    render(<ArtistCard artist={makeArtist({ providerArtistId: undefined })} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/artist/a1");
  });

  it("renders first genre when available", () => {
    render(<ArtistCard artist={makeArtist({ genres: ["Rock", "Pop"] })} />);
    expect(screen.getByText("Nghệ sĩ · Rock")).toBeTruthy();
  });

  it("hides genre when none available", () => {
    render(<ArtistCard artist={makeArtist({ genres: [] })} />);
    expect(screen.queryByText("Rock")).toBeNull();
    expect(screen.queryByText("Pop")).toBeNull();
  });
});
