// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import { FakeAudioSurface, makePlayableTrack } from "@/lib/player/__tests__/fake-audio";

const mocks = vi.hoisted(() => ({ getDefaultEngine: vi.fn() }));

vi.mock("@/lib/player/engine-factory", () => ({
  getDefaultEngine: mocks.getDefaultEngine,
}));

vi.mock("@/app/actions/playback", () => ({
  recordPlayedAction: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/app/actions/playback-state", () => ({
  getPlaybackStateAction: vi.fn().mockResolvedValue({ ok: true, state: null }),
  savePlaybackStateAction: vi.fn().mockResolvedValue({ ok: true }),
  clearPlaybackStateAction: vi.fn().mockResolvedValue({ ok: true }),
  getSessionUserIdAction: vi.fn().mockResolvedValue({ ok: true, userId: null }),
  resolvePlaybackTrackAction: vi.fn().mockResolvedValue({ ok: true, track: null }),
}));

vi.mock("@/app/actions/playback-resolve", () => ({
  resolveAudioSourceAction: vi.fn(async () => ({
    ok: true,
    source: { url: "https://audio.example/resolved.mp3" },
  })),
}));

// Engine-backed UI only renders queue rows whose tracks convert to an
// engine identity, so fixtures use the youtube provider here.
function yt(id: string, extra: Record<string, unknown> = {}) {
  return makePlayableTrack(id, { provider: "youtube", providerTrackId: id, ...extra });
}

function resetStore() {
  usePlayerStore.setState({
    currentTrack: null,
    isPlaying: false,
    isLoading: false,
    error: null,
    currentTime: 0,
    duration: 0,
    volume: 1,
    muted: false,
    queue: [],
    playOrder: [],
    position: -1,
    shuffle: false,
    repeat: "off",
    isQueueOpen: false,
    isFullPlayerOpen: false,
    qualifiedTrackKey: null,
  });
}

function mountWithEngine() {
  const surface = new FakeAudioSurface();
  const engine = new PlayerEngine(surface);
  mocks.getDefaultEngine.mockReturnValue(engine);
  return { surface, engine };
}

const bar = () => within(screen.getByRole("region", { name: "Thanh phát nhạc" }));

/**
 * Titles in the order the panel actually renders them.
 *
 * Asserting `usePlayerStore.getState().playOrder` alone is a false positive:
 * the model reorders correctly while the panel keeps painting the previous
 * order, because the rendered list was driven by a subscription that read
 * playOrder outside the store. The user-visible contract is the DOM.
 *
 * Scoped to the "Tiếp theo" section because the panel renders the current
 * track in its own "Đang phát" section ahead of the rest — whole-dialog DOM
 * order is the grouping, not the play sequence.
 */
function renderedOrder(): string[] {
  const section = screen.getByRole("region", { name: "Tiếp theo" });
  return within(section)
    .getAllByRole("listitem")
    .map((row) => row.querySelector("p")?.textContent ?? "");
}

/** Title of the track the panel shows as the current one. */
function renderedCurrent(): string | undefined {
  const section = screen.getByRole("region", { name: "Đang phát" });
  return within(section).getByRole("listitem").querySelector("p")?.textContent;
}

describe("Queue reorder buttons", () => {
  beforeEach(() => {
    resetStore();
    mountWithEngine();
  });

  afterEach(() => {
    cleanup();
    usePlayerStore.getState().bindEngine(null);
  });

  it("renders move up/down buttons for each queue item", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    const store = usePlayerStore.getState();
    store.replaceQueue([
      yt("a", { title: "Track A" }),
      yt("b", { title: "Track B" }),
      yt("c", { title: "Track C" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    expect(screen.getByRole("button", { name: "Chuyển “Track A” lên" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chuyển “Track A” xuống" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chuyển “Track B” lên" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chuyển “Track B” xuống" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chuyển “Track C” lên" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Chuyển “Track C” xuống" })).toBeTruthy();
  });

  it("disables Move Up for the first item", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A" }),
      yt("b", { title: "Track B" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    expect(screen.getByRole("button", { name: "Chuyển “Track A” lên" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Chuyển “Track A” xuống" })).toHaveProperty("disabled", false);
  });

  it("disables Move Down for the last item", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A" }),
      yt("b", { title: "Track B" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    expect(screen.getByRole("button", { name: "Chuyển “Track B” xuống" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Chuyển “Track B” lên" })).toHaveProperty("disabled", false);
  });

  it("moves an item up when Move Up is clicked", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A" }),
      yt("b", { title: "Track B" }),
      yt("c", { title: "Track C" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    fireEvent.click(screen.getByRole("button", { name: "Chuyển “Track B” lên" }));

    await waitFor(() => {
      const { playOrder, queue } = usePlayerStore.getState();
      expect(queue[playOrder[0]]?.id).toBe("b");
      expect(queue[playOrder[1]]?.id).toBe("a");
      expect(queue[playOrder[2]]?.id).toBe("c");
    });
    // The panel must repaint, not just the model. Regression: the rendered
    // order came from a non-reactive facade read, so the list kept showing
    // the old sequence while the engine played a different one. Track A is
    // still current, so it stays in the "Đang phát" section and only the
    // "Tiếp theo" sequence changes.
    await waitFor(() => {
      expect(renderedOrder()).toEqual(["Track B", "Track C"]);
      expect(renderedCurrent()).toBe("Track A");
    });
  });

  it("moves an item down when Move Down is clicked", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A" }),
      yt("b", { title: "Track B" }),
      yt("c", { title: "Track C" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Tiếp theo" }));
    await screen.findByRole("dialog", { name: "Hàng chờ" });

    fireEvent.click(screen.getByRole("button", { name: "Chuyển “Track B” xuống" }));

    await waitFor(() => {
      const { playOrder, queue } = usePlayerStore.getState();
      expect(queue[playOrder[0]]?.id).toBe("a");
      expect(queue[playOrder[1]]?.id).toBe("c");
      expect(queue[playOrder[2]]?.id).toBe("b");
    });
    await waitFor(() => {
      expect(renderedOrder()).toEqual(["Track C", "Track B"]);
      expect(renderedCurrent()).toBe("Track A");
    });
  });
});
