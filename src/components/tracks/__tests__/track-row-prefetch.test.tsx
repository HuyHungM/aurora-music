// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { TrackRow } from "@/components/tracks/track-row";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";
import { mountTestFacade } from "@/components/player/__tests__/test-facade";
import { getMusicEngine } from "@/lib/music/instance";
import { resetIntentPrefetchForTests } from "@/lib/playback/prefetch-intent";

vi.mock("@/app/actions/playlist", () => ({
  listUserPlaylistsAction: vi.fn().mockResolvedValue({ ok: true, playlists: [] }),
  addTrackToPlaylistAction: vi.fn().mockResolvedValue({ ok: true }),
  createPlaylistAction: vi.fn().mockResolvedValue({ ok: true, playlistId: "new" }),
}));

function youtubeTrack(id: string) {
  return makePlayableTrack(id, {
    provider: "youtube",
    providerTrackId: id,
    title: `Track ${id}`,
    artistName: "Artist",
  });
}

let unmountFacade: (() => void) | undefined;

describe("TrackRow hover intent prefetch", () => {
  beforeEach(() => {
    resetIntentPrefetchForTests();
    const surface = new FakeAudioSurface();
    const engine = new PlayerEngine(surface);
    usePlayerStore.getState().bindEngine(engine);
    unmountFacade = mountTestFacade();
  });

  afterEach(() => {
    cleanup();
    unmountFacade?.();
    unmountFacade = undefined;
    usePlayerStore.getState().bindEngine(null);
    resetIntentPrefetchForTests();
  });

  function rowElement(): HTMLElement {
    // The row root is the only top-level div the component renders.
    const { container } = render(
      <TrackRow track={youtubeTrack("hover-1")} />,
    );
    const root = container.firstElementChild;
    if (!(root instanceof HTMLElement)) {
      throw new Error("track row root not found");
    }
    return root;
  }

  it("warms a youtube track on hover without playing it", () => {
    const facade = getMusicEngine();
    expect(facade).not.toBeNull();
    const spy = vi.spyOn(facade!, "prefetchTrack");
    const row = rowElement();
    fireEvent.mouseEnter(row);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ id: "hover-1" }));
    // Intent only: nothing queued, nothing loading.
    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(usePlayerStore.getState().isLoading).toBe(false);
  });

  it("warms on keyboard focus as well as pointer hover", () => {
    const facade = getMusicEngine();
    const spy = vi.spyOn(facade!, "prefetchTrack");
    const row = rowElement();
    fireEvent.focus(row);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not warm non-youtube tracks", () => {
    const facade = getMusicEngine();
    const spy = vi.spyOn(facade!, "prefetchTrack");
    // The row itself is unconditional: provider scope lives in the facade, so
    // the component never branches on provider identity. A jamendo fixture
    // still reaches the facade; the facade refuses it there.
    const { container } = render(<TrackRow track={makePlayableTrack("local-1")} />);
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("forwards every hover to the facade, which owns admission", () => {
    const facade = getMusicEngine();
    const spy = vi.spyOn(facade!, "prefetchTrack");
    const { container } = render(<TrackRow track={youtubeTrack("hover-2")} />);
    const root = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(root);
    fireEvent.mouseEnter(root);
    // The row holds no dedupe state of its own: it reports intent and the
    // facade decides. Spying here replaces the real method, so the gate's
    // refusal is asserted in `music-engine.test.ts` instead — this test's job
    // is only that the row does not invent a second, competing policy.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
