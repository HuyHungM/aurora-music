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

const bar = () => within(screen.getByRole("region", { name: "Player bar" }));

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

    fireEvent.click(bar().getByRole("button", { name: "Up next" }));
    await screen.findByRole("dialog", { name: "Queue" });

    expect(screen.getByRole("button", { name: 'Move "Track A" up' })).toBeTruthy();
    expect(screen.getByRole("button", { name: 'Move "Track A" down' })).toBeTruthy();
    expect(screen.getByRole("button", { name: 'Move "Track B" up' })).toBeTruthy();
    expect(screen.getByRole("button", { name: 'Move "Track B" down' })).toBeTruthy();
    expect(screen.getByRole("button", { name: 'Move "Track C" up' })).toBeTruthy();
    expect(screen.getByRole("button", { name: 'Move "Track C" down' })).toBeTruthy();
  });

  it("disables Move Up for the first item", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A" }),
      yt("b", { title: "Track B" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Up next" }));
    await screen.findByRole("dialog", { name: "Queue" });

    expect(screen.getByRole("button", { name: 'Move "Track A" up' })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: 'Move "Track A" down' })).toHaveProperty("disabled", false);
  });

  it("disables Move Down for the last item", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A" }),
      yt("b", { title: "Track B" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Up next" }));
    await screen.findByRole("dialog", { name: "Queue" });

    expect(screen.getByRole("button", { name: 'Move "Track B" down' })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: 'Move "Track B" up' })).toHaveProperty("disabled", false);
  });

  it("moves an item up when Move Up is clicked", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    usePlayerStore.getState().replaceQueue([
      yt("a", { title: "Track A" }),
      yt("b", { title: "Track B" }),
      yt("c", { title: "Track C" }),
    ]);

    fireEvent.click(bar().getByRole("button", { name: "Up next" }));
    await screen.findByRole("dialog", { name: "Queue" });

    fireEvent.click(screen.getByRole("button", { name: 'Move "Track B" up' }));

    await waitFor(() => {
      const { playOrder, queue } = usePlayerStore.getState();
      expect(queue[playOrder[0]]?.id).toBe("b");
      expect(queue[playOrder[1]]?.id).toBe("a");
      expect(queue[playOrder[2]]?.id).toBe("c");
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

    fireEvent.click(bar().getByRole("button", { name: "Up next" }));
    await screen.findByRole("dialog", { name: "Queue" });

    fireEvent.click(screen.getByRole("button", { name: 'Move "Track B" down' }));

    await waitFor(() => {
      const { playOrder, queue } = usePlayerStore.getState();
      expect(queue[playOrder[0]]?.id).toBe("a");
      expect(queue[playOrder[1]]?.id).toBe("c");
      expect(queue[playOrder[2]]?.id).toBe("b");
    });
  });
});
