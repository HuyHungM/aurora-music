import { describe, expect, it } from "vitest";
import { hasArtwork, resolveArtworkUrl } from "@/lib/domain/artwork";
import type { Artwork } from "@/lib/domain/artwork";

describe("Artwork", () => {
  it("resolves the preferred semantic size", () => {
    const artwork: Artwork = {
      small: "https://cdn.example/s.jpg",
      medium: "https://cdn.example/m.jpg",
      large: "https://cdn.example/l.jpg",
    };
    expect(resolveArtworkUrl(artwork, "small")).toBe("https://cdn.example/s.jpg");
    expect(resolveArtworkUrl(artwork, "medium")).toBe("https://cdn.example/m.jpg");
    expect(resolveArtworkUrl(artwork, "large")).toBe("https://cdn.example/l.jpg");
  });

  it("falls back deterministically when the preferred size is missing", () => {
    const artwork: Artwork = { large: "https://cdn.example/l.jpg" };
    expect(resolveArtworkUrl(artwork, "small")).toBe("https://cdn.example/l.jpg");
    expect(resolveArtworkUrl({ small: "https://cdn.example/s.jpg" }, "large")).toBe(
      "https://cdn.example/s.jpg",
    );
  });

  it("returns undefined for missing or empty artwork", () => {
    expect(resolveArtworkUrl(undefined)).toBeUndefined();
    expect(resolveArtworkUrl(null)).toBeUndefined();
    expect(resolveArtworkUrl({})).toBeUndefined();
    expect(resolveArtworkUrl({ small: "" })).toBeUndefined();
    expect(hasArtwork({})).toBe(false);
  });

  it("reports presence when any semantic size exists", () => {
    expect(hasArtwork({ medium: "https://cdn.example/m.jpg" })).toBe(true);
    expect(hasArtwork(undefined)).toBe(false);
  });
});
