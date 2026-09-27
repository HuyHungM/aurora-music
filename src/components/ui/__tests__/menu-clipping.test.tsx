// @vitest-environment jsdom
/**
 * A menu has to be able to leave the card it was opened from.
 *
 * These two cards are the surfaces in the product that a track action menu
 * opens from INSIDE a rounded box, and both of them used to carry
 * `overflow-hidden` on the box itself. A menu is deliberately larger than the
 * row of controls that opens it, so the clip cost real pixels: on the search
 * top result it ate 120px of a 162px menu, leaving two of five items visible.
 *
 * jsdom has no layout, so the assertion here is about the classes that decide
 * the clip, not about the pixels that result. The pixels are asserted in
 * `e2e/menu-clipping.spec.ts`, which has a real box model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EntityHeader } from "@/components/ui/entity-header";
import { TopResultCard } from "@/app/(app)/search/top-result-card";
import { TrackActionMenu } from "@/components/tracks/track-action-menu";
import type { Track } from "@/lib/domain";

vi.mock("@/lib/player/engine-factory", () => ({
  createPlayerEngine: () => ({
    load: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    seek: vi.fn(),
    destroy: vi.fn(),
    setVolume: vi.fn(),
    getVolume: () => 1,
    getCurrentTime: () => 0,
    getDuration: () => 0,
    on: vi.fn(),
    queue: { add: vi.fn(), playNext: vi.fn(), remove: vi.fn(), move: vi.fn() },
  }),
}));

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  createPlaylistAction: vi.fn().mockResolvedValue({ ok: true, playlistId: "new" }),
}));

/** Utility classes that establish a clip box. Tailwind's `overflow-hidden`
 *  family, plus the two that clip a single axis, plus `clip`. */
const CLIP_TOKENS = new Set([
  "overflow-hidden",
  "overflow-clip",
  "overflow-x-hidden",
  "overflow-y-hidden",
  "overflow-x-clip",
  "overflow-y-clip",
  "overflow-auto",
  "overflow-scroll",
]);

function clips(element: Element | null): string[] {
  const out: string[] = [];
  // The surface itself carries `overflow-hidden` - it has to, to round its own
  // items - so the walk starts one node out, at the container that was
  // supposed to hold it.
  let node = element?.parentElement ?? null;
  while (node) {
    for (const token of (node.className || "").toString().split(/\s+/)) {
      if (CLIP_TOKENS.has(token)) out.push(`${node.tagName.toLowerCase()}.${token}`);
    }
    node = node.parentElement;
  }
  return out;
}

const track: Track = {
  id: "t1",
  provider: "mock",
  providerTrackId: "mock-t1",
  title: "Track t1",
  artistId: "a1",
  artistName: "Test Artist",
  streamUrl: "https://example.com/t1.mp3",
};

async function openTheMenu() {
  const trigger = screen.getByRole("button", { name: "Thao tác với Track t1" });
  trigger.click();
  const menu = await screen.findByRole("menu", { name: "Thao tác với bài hát" });
  return { trigger, menu };
}

describe("a card that hosts a menu trigger", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not clip the entity header's action menu", async () => {
    render(
      <EntityHeader
        artworkAlt="cover"
        eyebrow="Bài hát"
        title="Track t1"
        actions={<TrackActionMenu track={track} />}
      />,
    );

    const { menu } = await openTheMenu();
    expect(clips(menu)).toEqual([]);
  });

  it("does not clip the search top result's action menu", async () => {
    render(
      <TopResultCard
        track={track}
        eyebrow="Spotify · Bài hát"
        actions={<TrackActionMenu track={track} />}
      />,
    );

    const { menu } = await openTheMenu();
    expect(clips(menu)).toEqual([]);
  });

  it("rounds the decorative wash itself, so the corners survive the clip", () => {
    const { container } = render(
      <EntityHeader artworkAlt="cover" eyebrow="Bài hát" title="Track t1" />,
    );
    const root = container.firstElementChild!;
    expect(root.className).not.toContain("overflow");
    // The wash is the only child that could reach a corner now that the root
    // does not clip, so the radius has to travel with it.
    const wash = root.querySelector('[aria-hidden="true"]')!;
    expect(wash.className).toContain("rounded-2xl");
  });
});
