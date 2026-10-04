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

    it("mirrors TrackRow's own box so rows do not shift on populate", () => {
      // `TrackRow` is `flex items-center gap-3 rounded-xl px-2 py-2` with
      // 44px `h-11 w-11` art and an `h-11 w-11 rounded-full` trailing Play
      // control. Each half of that contract is asserted so a drift on either
      // side fails here rather than as a layout jump in the browser.
      const { container } = render(<TrackListSkeleton rows={2} />);
      const rows = container.querySelectorAll("li");
      expect(rows).toHaveLength(2);
      for (const row of Array.from(rows)) {
        expect(row.className).toContain("rounded-xl");
        const art = row.querySelector(".h-11.w-11:not(.rounded-full)");
        expect(art).toBeTruthy();
        const trailing = row.querySelector(".h-11.w-11.rounded-full");
        expect(trailing).toBeTruthy();
      }
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

    it("mirrors /radio's own page shell, not a generic card grid", () => {
      // The page is `flex-col gap-6 sm:gap-10`: a skeleton on `gap-10` alone
      // sits every section lower than the real page does on mobile.
      const { container } = render(<RadioSkeleton />);
      const root = container.querySelector('[aria-busy="true"]');
      expect(root?.className).toContain("gap-6");
      expect(root?.className).toContain("sm:gap-10");
    });

    it("renders the discovery start control as a button block", () => {
      // The real header ends in the primary `h-12` discovery CTA, not a text
      // line. A skeleton without it collapses the header by a full control
      // height when content lands.
      const { container } = render(<RadioSkeleton />);
      expect(container.querySelector(".h-12.w-40.rounded-full")).toBeTruthy();
    });

    it("renders library-artist rows in the real grid with real row boxes", () => {
      // Real section: `grid-cols-1 sm:grid-cols-2`, rows
      // `rounded-xl border bg-surface-1 px-4 py-3` with a trailing action.
      const { container } = render(<RadioSkeleton />);
      const grid = container.querySelector(".grid-cols-1.sm\\:grid-cols-2");
      expect(grid).toBeTruthy();
      const rows = grid?.querySelectorAll(".rounded-xl.border") ?? [];
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of Array.from(rows)) {
        expect(row.className).toContain("px-4");
        expect(row.querySelector(".rounded-full")).toBeTruthy();
      }
    });

    it("renders the explore list inside the real track container", () => {
      // The popular-tracks `TrackList` lives in
      // `rounded-2xl border bg-surface-1/60 p-2`; the skeleton must use the
      // same container, not a bare list, or the section re-boxes on populate.
      const { container } = render(<RadioSkeleton />);
      const explore = container.querySelector(
        ".rounded-2xl.border.border-border-subtle.bg-surface-1\\/60",
      );
      expect(explore).toBeTruthy();
      expect(explore?.querySelectorAll("li").length).toBeGreaterThanOrEqual(5);
      // And every skeleton row ends in the row's own trailing Play circle.
      const circles = explore?.querySelectorAll(".h-11.w-11.rounded-full") ?? [];
      expect(circles.length).toBeGreaterThanOrEqual(5);
    });

    it("keeps every radius inside the rounded system", () => {
      // Circles for round controls, `rounded-xl` for rows, `rounded-2xl` for
      // the one large container. No `rounded-lg` standing in for a bar.
      // (`rounded-md` appears only as the shared `Skeleton` primitive's own
      // base, always overridden by the caller's explicit radius — the same
      // contract every other skeleton in this file relies on.)
      const { container } = render(<RadioSkeleton />);
      const html = container.innerHTML;
      expect(html).not.toContain("rounded-lg");
      expect(container.querySelector(".rounded-2xl")).toBeTruthy();
      expect(container.querySelector(".rounded-xl")).toBeTruthy();
      expect(container.querySelector(".rounded-full")).toBeTruthy();
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
