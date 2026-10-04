// @vitest-environment jsdom
/**
 * The player-surface gaps closed in this pass.
 *
 *   1. Queue clear — `clearQueue` existed in the store since the queue did and
 *      had zero production callers, so a long radio session had no exit.
 *   2. Mini-player Retry — the bar and the full player reported a failed track
 *      with a Retry; the mini player, which is the ONLY player on a phone,
 *      showed the error text and nothing else.
 *   3. Track announcement — the player was operable but silent: no live region
 *      announced a track change, so a screen-reader user pressing "next" heard
 *      nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { PlayerHost } from "@/components/player/player-host";
import { usePlayerStore } from "@/lib/player/store";
import { PlayerEngine } from "@/lib/player/engine";
import {
  FakeAudioSurface,
  makePlayableTrack,
} from "@/lib/player/__tests__/fake-audio";
import { clearNotifications } from "@/components/ui/notifications";

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

vi.mock("@/lib/dal/session", () => ({
  getSessionUserId: vi.fn().mockResolvedValue(null),
  getCurrentUser: vi.fn().mockResolvedValue(null),
  requireUser: vi.fn().mockRejectedValue(new Error("unauthenticated")),
}));

function yt(id: string, title: string) {
  return makePlayableTrack(id, {
    provider: "youtube",
    providerTrackId: id,
    title,
    artistName: `Artist ${id}`,
  });
}

// Exact region names. A loose regex matches the mini player too, and both
// surfaces carry an "Up next" control, which makes every queue-trigger query
// ambiguous.
const bar = () =>
  within(screen.getByRole("region", { name: "Thanh phát nhạc" }));
const mini = () =>
  within(screen.getByRole("region", { name: "Trình phát thu gọn" }));

const UP_NEXT = "Tiếp theo";
const QUEUE_DIALOG = "Hàng chờ";
const CLEAR = "Xóa hàng đợi";
const RETRY = "Thử phát lại";

beforeEach(() => {
  clearNotifications();
  const audio = new FakeAudioSurface();
  mocks.getDefaultEngine.mockImplementation(
    () => new PlayerEngine(audio as unknown as ConstructorParameters<typeof PlayerEngine>[0]),
  );
});

afterEach(() => {
  cleanup();
  clearNotifications();
  usePlayerStore.getState().clearQueue();
  vi.clearAllMocks();
});

describe("queue clear", () => {
  it("exposes a control that empties the queue", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    act(() => {
      usePlayerStore
        .getState()
        .replaceQueue([yt("a", "Track A"), yt("b", "Track B"), yt("c", "Track C")]);
    });

    fireEvent.click(bar().getByRole("button", { name: UP_NEXT }));
    await screen.findByRole("dialog", { name: QUEUE_DIALOG });
    expect(usePlayerStore.getState().queue).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: CLEAR }));

    await waitFor(() => expect(usePlayerStore.getState().queue).toHaveLength(0));
  });

  it("is safe on an already-empty queue", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    fireEvent.click(bar().getByRole("button", { name: UP_NEXT }));
    await screen.findByRole("dialog", { name: QUEUE_DIALOG });

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: CLEAR })),
    ).not.toThrow();
    expect(usePlayerStore.getState().queue).toHaveLength(0);
  });

  it("stops playback and leaves no stale track behind", async () => {
    // The clear goes through the EXISTING store contract, which stops the
    // controller and nulls the current track. Asserting the END STATE rather
    // than "the panel stayed open": an emptied queue has no current track, and
    // the panel legitimately goes with it.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    act(() => {
      usePlayerStore
        .getState()
        .replaceQueue([yt("a", "Track A"), yt("b", "Track B")]);
    });
    await waitFor(() =>
      expect(usePlayerStore.getState().currentTrack).toBeTruthy(),
    );

    fireEvent.click(bar().getByRole("button", { name: UP_NEXT }));
    await screen.findByRole("dialog", { name: QUEUE_DIALOG });

    const clear = screen.getByRole("button", { name: CLEAR });
    // The panel's outside dismissal listens on `pointerdown`, which precedes
    // `click`, so the clear must stop the event there. A click alone cannot
    // exercise that guard — this test is why the `onPointerDown` exists.
    fireEvent.pointerDown(clear);
    fireEvent.click(clear);

    await waitFor(() => expect(usePlayerStore.getState().queue).toHaveLength(0));
    expect(usePlayerStore.getState().currentTrack).toBeNull();
    expect(usePlayerStore.getState().isPlaying).toBe(false);
    expect(usePlayerStore.getState().playOrder).toEqual([]);
  });
});

describe("mini player retry", () => {
  it("offers Retry on the smallest player surface when a track fails", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    act(() => {
      usePlayerStore
        .getState()
        .replaceQueue([yt("a", "Track A"), yt("b", "Track B")]);
      usePlayerStore.setState({
        error: {
          name: "PlayerError",
          message: "no playable stream",
          detail: undefined,
        } as never,
      });
    });

    // The mini player is the ONLY player on a phone; it previously showed the
    // error text with no affordance at all.
    await waitFor(() =>
      expect(mini().getByRole("button", { name: RETRY })).toBeTruthy(),
    );
  });

  it("shows no Retry while nothing has failed", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    act(() => {
      usePlayerStore.getState().replaceQueue([yt("a", "Track A")]);
    });

    expect(mini().queryByRole("button", { name: RETRY })).toBeNull();
  });

  it("retries the current queue slot, not the elapsed position", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    act(() => {
      usePlayerStore
        .getState()
        .replaceQueue([yt("a", "Track A"), yt("b", "Track B")]);
      // The STORE's slot field is `position`; the ENGINE SNAPSHOT the component
      // reads exposes it as `currentIndex` and exposes elapsed seconds as
      // `position`. Setting the store's slot to 1 with `currentTime` 0 makes the
      // two snapshot fields disagree — `currentIndex: 1` vs `position: 0` — so a
      // component that read the wrong one calls `playAt(0)` and lands on track
      // A. Asserting "B" is what proves the correct field was read.
      usePlayerStore.setState({
        position: 1,
        currentTime: 0,
        error: {
          name: "PlayerError",
          message: "boom",
          detail: undefined,
        } as never,
      });
    });

    fireEvent.click(mini().getByRole("button", { name: RETRY }));

    // Observable outcome: queue slot 1 is what starts playing.
    await waitFor(() =>
      expect(usePlayerStore.getState().currentTrack?.id).toBe("b"),
    );
  });
});

describe("track announcement", () => {
  it("announces through exactly one live region, mounted empty", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    // ONE region, mounted empty from first paint. A live region inserted
    // together with its content is commonly not announced at all — the same
    // failure the notification host had.
    const regions = document.querySelectorAll("[data-track-announcer]");
    expect(regions).toHaveLength(1);
    expect(regions[0]?.getAttribute("aria-live")).toBe("polite");
    expect(regions[0]?.textContent).toBe("");
  });

  it("updates on a track change and not on a position tick", async () => {
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());

    act(() => {
      usePlayerStore.getState().replaceQueue([yt("a", "Track A")]);
    });

    const region = document.querySelector("[data-track-announcer]");
    await waitFor(() => expect(region?.textContent).toContain("Track A"));
    const before = region?.textContent;

    // A position tick must NOT re-announce: the region carries identity only,
    // never elapsed time, so React sees no text change.
    act(() => {
      usePlayerStore.setState({ position: 42, currentTime: 42_000 });
    });
    expect(region?.textContent).toBe(before);

    act(() => {
      usePlayerStore.getState().replaceQueue([yt("b", "Track B")]);
    });
    await waitFor(() => expect(region?.textContent).toContain("Track B"));
  });

  it("does not compete with the player bar's error banner role", async () => {
    // The bar's failure message is `role="status"`. If the announcer used the
    // same role, "which region spoke?" would be ambiguous for assistive tech and
    // for any query for a status message.
    render(<PlayerHost />);
    await waitFor(() => expect(mocks.getDefaultEngine).toHaveBeenCalled());
    act(() => {
      usePlayerStore.getState().replaceQueue([yt("a", "Track A")]);
    });

    expect(
      document.querySelector("[data-track-announcer]")?.getAttribute("role"),
    ).toBeNull();
  });
});
