// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { Track } from "@/lib/domain";
import {
  AUTH_REQUIRED_EVENT,
  AuthPromptHost,
  LikedTracksProvider,
  likedTrackKey,
  useLikedTrack,
} from "@/components/tracks/liked-tracks";

vi.mock("@/app/actions/track", () => ({
  likeTrackAction: vi.fn(async () => ({ ok: true, liked: true })),
  unlikeTrackAction: vi.fn(async () => ({ ok: true, liked: false })),
}));

import {
  likeTrackAction,
  unlikeTrackAction,
} from "@/app/actions/track";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeTrack(id: string): Track {
  return {
    id,
    provider: "youtube",
    providerTrackId: id,
    title: `Track ${id}`,
    artistId: "a1",
    artistName: "Artist",
  };
}

function Probe({ track }: { track: Track }) {
  const state = useLikedTrack(track);
  if (!state) {
    return <span>no-context</span>;
  }
  return (
    <button
      type="button"
      onClick={state.toggle}
      disabled={state.pending}
      aria-pressed={state.liked}
    >
      {state.liked ? "liked" : "unliked"}
    </button>
  );
}

describe("likedTrackKey", () => {
  it("mirrors the DAL Like identity (providerTrackId wins)", () => {
    expect(likedTrackKey(makeTrack("v1"))).toBe("youtube:v1");
    expect(
      likedTrackKey({ provider: "deezer", id: "internal", providerTrackId: "dz9" }),
    ).toBe("deezer:dz9");
  });
});

describe("LikedTracksProvider", () => {
  it("seeds liked state from the server and toggles optimistically", async () => {
    const user = userEvent.setup();
    const track = makeTrack("v1");
    render(
      <LikedTracksProvider initialLiked={["youtube:v1"]} isAuthenticated={true}>
        <Probe track={track} />
      </LikedTracksProvider>,
    );
    expect(screen.getByRole("button", { name: "liked" })).toBeTruthy();

    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button", { name: "unliked" })).toBeTruthy();
    expect(unlikeTrackAction).toHaveBeenCalledTimes(1);
  });

  it("rolls back when the server mutation fails", async () => {
    vi.mocked(likeTrackAction).mockResolvedValueOnce({ ok: false, liked: false });
    const user = userEvent.setup();
    const track = makeTrack("v2");
    render(
      <LikedTracksProvider initialLiked={[]} isAuthenticated={true}>
        <Probe track={track} />
      </LikedTracksProvider>,
    );
    await user.click(screen.getByRole("button"));
    expect(await screen.findByRole("button", { name: "unliked" })).toBeTruthy();
    expect(likeTrackAction).toHaveBeenCalledTimes(1);
  });

  /**
   * Phase 49 regression. The mutation IIFE had no rejection handling, so a
   * dropped request skipped the rollback, `inFlightRef.delete(key)` and
   * `setPending(...)` together. The heart stayed visually filled for a write
   * that never happened, the in-flight guard kept the key, and the button
   * stayed disabled — a permanent lockout of Like for that track.
   */
  it("rolls back and re-enables when the mutation rejects", async () => {
    vi.mocked(likeTrackAction).mockRejectedValueOnce(new Error("network down"));
    // A dropped request is not an authorization failure, so it must not be
    // dressed up as one with a sign-in prompt.
    const promptListener = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, promptListener);
    try {
      const user = userEvent.setup();
      const track = makeTrack("v-reject");
      render(
        <LikedTracksProvider initialLiked={[]} isAuthenticated={true}>
          <Probe track={track} />
        </LikedTracksProvider>,
      );

      await user.click(screen.getByRole("button"));

      // Rolled back to the honest state rather than left optimistically liked.
      expect(await screen.findByRole("button", { name: "unliked" })).toBeTruthy();
      expect(promptListener).not.toHaveBeenCalled();

      // The control is live again. A stuck in-flight ref would make this
      // second click a silent no-op — the permanent-lockout failure mode.
      await user.click(screen.getByRole("button"));
      await waitFor(() => {
        expect(likeTrackAction).toHaveBeenCalledTimes(2);
      });
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, promptListener);
    }
  });

  it("ignores duplicate toggles while a mutation is pending", async () => {
    let release!: () => void;
    const gate = new Promise<{ ok: boolean; liked: boolean }>((resolve) => {
      release = () => resolve({ ok: true, liked: true });
    });
    vi.mocked(likeTrackAction).mockReturnValueOnce(gate);
    const user = userEvent.setup();
    const track = makeTrack("v3");
    render(
      <LikedTracksProvider initialLiked={[]} isAuthenticated={true}>
        <Probe track={track} />
      </LikedTracksProvider>,
    );
    const button = screen.getByRole("button");
    await user.click(button);
    await user.click(button);
    await act(async () => {
      release();
    });
    expect(likeTrackAction).toHaveBeenCalledTimes(1);
  });

  it("raises the shared sign-in prompt for anonymous failures", async () => {
    vi.mocked(likeTrackAction).mockResolvedValueOnce({ ok: false, liked: false });
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    try {
      const user = userEvent.setup();
      render(
        <LikedTracksProvider initialLiked={[]} isAuthenticated={false}>
          <Probe track={makeTrack("v4")} />
        </LikedTracksProvider>,
      );
      await user.click(screen.getByRole("button"));
      expect(await screen.findByRole("button", { name: "unliked" })).toBeTruthy();
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    }
  });

  it("stays silent for authenticated failures (no false sign-in prompt)", async () => {
    vi.mocked(likeTrackAction).mockResolvedValueOnce({ ok: false, liked: false });
    const listener = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);
    try {
      const user = userEvent.setup();
      render(
        <LikedTracksProvider initialLiked={[]} isAuthenticated={true}>
          <Probe track={makeTrack("v5")} />
        </LikedTracksProvider>,
      );
      await user.click(screen.getByRole("button"));
      expect(await screen.findByRole("button", { name: "unliked" })).toBeTruthy();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    }
  });
});

describe("AuthPromptHost", () => {
  it("opens on the shared event and shows the existing sign-in flow", async () => {
    const user = userEvent.setup();
    render(<AuthPromptHost signIn={<button type="button">Sign in now</button>} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
    });
    expect(screen.getByRole("dialog", { name: "Cần đăng nhập" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in now" })).toBeTruthy();
    await user.keyboard("{Escape}");
    // The prompt plays its exit before unmounting (Phase 48), so the
    // dialog is briefly still in the document — inert, and out of the
    // accessibility tree — and then gone. Queried by attribute: an inert
    // element is meant to be unreachable by role.
    expect(
      document.querySelector('[data-presence="exiting"][role="dialog"]'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
