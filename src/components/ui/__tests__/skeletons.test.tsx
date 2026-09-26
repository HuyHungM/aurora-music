// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  TrackListSkeleton,
  HeroSkeleton,
  CardGridSkeleton,
  LibrarySkeleton,
  RadioSkeleton,
  PageSkeleton,
  ArtistDetailSkeleton,
  AlbumDetailSkeleton,
  TrackDetailSkeleton,
} from "@/components/ui/skeletons";

function expectAriaBusy(container: HTMLElement) {
  const el = container.querySelector("[aria-busy=\"true\"]");
  expect(el).toBeTruthy();
}

describe("Skeleton components", () => {
  describe("TrackListSkeleton", () => {
    it("renders with aria-busy", () => {
      const { container } = render(<TrackListSkeleton />);
      expectAriaBusy(container);
    });

    it("renders custom row count", () => {
      const { container } = render(<TrackListSkeleton rows={3} />);
      expect(container.querySelectorAll("li")).toHaveLength(3);
    });

    it("renders header when header=true", () => {
      const { container } = render(<TrackListSkeleton header />);
      expect(container.querySelector(".h-5")).toBeTruthy();
    });
  });

  describe("HeroSkeleton", () => {
    it("renders with aria-busy", () => {
      const { container } = render(<HeroSkeleton />);
      expectAriaBusy(container);
    });
  });

  describe("CardGridSkeleton", () => {
    it("renders default 5 cards", () => {
      const { container } = render(<CardGridSkeleton />);
      expect(container.querySelectorAll(".aspect-square")).toHaveLength(5);
    });

    it("renders custom count", () => {
      const { container } = render(<CardGridSkeleton count={2} />);
      expect(container.querySelectorAll(".aspect-square")).toHaveLength(2);
    });
  });

  describe("LibrarySkeleton", () => {
    it("renders with aria-busy", () => {
      const { container } = render(<LibrarySkeleton />);
      expectAriaBusy(container);
    });
  });

  describe("RadioSkeleton", () => {
    it("renders with aria-busy", () => {
      const { container } = render(<RadioSkeleton />);
      expectAriaBusy(container);
    });
  });

  describe("PageSkeleton", () => {
    it("renders with aria-busy", () => {
      const { container } = render(<PageSkeleton />);
      expectAriaBusy(container);
    });
  });

  describe("ArtistDetailSkeleton", () => {
    it("renders with aria-busy", () => {
      const { container } = render(<ArtistDetailSkeleton />);
      expectAriaBusy(container);
    });
  });

  describe("AlbumDetailSkeleton", () => {
    it("renders with aria-busy", () => {
      const { container } = render(<AlbumDetailSkeleton />);
      expectAriaBusy(container);
    });
  });

  describe("TrackDetailSkeleton", () => {
    it("renders with aria-busy", () => {
      const { container } = render(<TrackDetailSkeleton />);
      expectAriaBusy(container);
    });
  });
});
