// @vitest-environment jsdom
/**
 * The empty state's title is a heading, and a heading that skips a level breaks
 * the outline a screen-reader user navigates by. The level therefore depends on
 * where the empty state sits, which is why it is a prop instead of a constant.
 *
 * Lighthouse's `heading-order` audit reported `h1` then `h3` with nothing
 * between on the home page: the two empty states that ARE the section rendered
 * their titles at the level meant for a title INSIDE a section.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EmptyState } from "@/components/ui/empty-state";

describe("EmptyState", () => {
  afterEach(cleanup);

  it("is a level-3 heading by default, for a title inside a section", () => {
    render(<EmptyState title="No likes yet" description="Search for something." />);
    // A section that already has a heading puts the empty state one level
    // below it, which is what the default is for.
    expect(screen.getByRole("heading", { level: 3, name: "No likes yet" })).toBeTruthy();
  });

  it("renders as a level-2 heading when the empty state is the section", () => {
    render(
      <EmptyState
        title="Nothing played yet"
        headingLevel={2}
        action={<a href="/radio">Start radio</a>}
      />,
    );
    // A page reading h1 then this title must not skip to h3.
    expect(screen.getByRole("heading", { level: 2, name: "Nothing played yet" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("answers all three questions: what is empty, why, what to do", () => {
    render(
      <EmptyState
        title="No playlists"
        description="Playlists you create show up here."
        action={<a href="/search">Browse</a>}
      />,
    );
    expect(screen.getByText("No playlists")).toBeTruthy();
    expect(screen.getByText("Playlists you create show up here.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse" })).toBeTruthy();
  });
});
