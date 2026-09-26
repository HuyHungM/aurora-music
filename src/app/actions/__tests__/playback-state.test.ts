import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dal/session", () => ({
  requireUser: vi.fn(),
  getSessionUserId: vi.fn(),
}));

vi.mock("@/lib/dal/playback-state", () => ({
  clearPlaybackState: vi.fn(),
  getPlaybackState: vi.fn(),
  savePlaybackState: vi.fn(),
}));

vi.mock("@/lib/providers/server", () => ({
  fetchTrackDetail: vi.fn(),
  // The action warms the registry before resolving, so that a cold process
  // cannot mistake "not registered yet" for "track no longer exists".
  getShellProviders: vi.fn(() => []),
}));

vi.mock("@/lib/providers/registry", () => ({
  getProvider: vi.fn(),
}));

import { requireUser, getSessionUserId } from "@/lib/dal/session";
import {
  clearPlaybackState,
  getPlaybackState,
  savePlaybackState,
} from "@/lib/dal/playback-state";
import { fetchTrackDetail, getShellProviders } from "@/lib/providers/server";
import { getProvider } from "@/lib/providers/registry";
import { QUEUE_SNAPSHOT_VERSION } from "@/lib/player/queue-snapshot";
import {
  clearPlaybackStateAction,
  getPlaybackStateAction,
  getSessionUserIdAction,
  resolvePlaybackTrackAction,
  savePlaybackStateAction,
} from "../playback-state";

describe("playback-state server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPlaybackStateAction", () => {
    it("returns the authenticated user's state", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(getPlaybackState).mockResolvedValue({
        provider: "mock",
        providerTrackId: "t-1",
        position: 83,
        revision: 4,
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        queueSnapshot: null,
      });

      const result = await getPlaybackStateAction();

      expect(result).toEqual({
        ok: true,
        state: {
          provider: "mock",
          providerTrackId: "t-1",
          position: 83,
          revision: 4,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      });
      expect(getPlaybackState).toHaveBeenCalledWith("user-1");
    });

    it("returns null state when nothing is persisted", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(getPlaybackState).mockResolvedValue(null);

      const result = await getPlaybackStateAction();

      expect(result).toEqual({ ok: true, state: null });
    });

    it("returns ok:false when unauthenticated", async () => {
      vi.mocked(requireUser).mockRejectedValue(new Error("nope"));

      const result = await getPlaybackStateAction();

      expect(result).toEqual({ ok: false });
      expect(getPlaybackState).not.toHaveBeenCalled();
    });
  });

  describe("savePlaybackStateAction", () => {
    it("saves a valid checkpoint for the authenticated user", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(savePlaybackState).mockResolvedValue(true);

      const result = await savePlaybackStateAction({
        provider: "mock",
        providerTrackId: "t-1",
        position: 42,
        revision: 3,
      });

      expect(result).toEqual({ ok: true });
      expect(savePlaybackState).toHaveBeenCalledWith("user-1", {
        provider: "mock",
        providerTrackId: "t-1",
        position: 42,
        revision: 3,
        // A legacy-shaped save carries no snapshot, which must reach the DAL
        // as `undefined` ("leave the column untouched") — never as `null`,
        // which is an explicit instruction to erase a stored queue.
        queueSnapshot: undefined,
      });
    });

    it("leaves a stored queue untouched when the caller omits queueSnapshot", async () => {
      // Regression: an absent field used to be coerced to null, and the DAL
      // reads null as an explicit SQL NULL. Any caller that omitted the field
      // — an older deployed tab mid-rollout, or a crafted request — therefore
      // erased the user's whole persisted queue on a routine checkpoint.
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(savePlaybackState).mockResolvedValue(true);

      await savePlaybackStateAction({
        provider: "mock",
        providerTrackId: "t-1",
        position: 0,
        revision: 0,
      });

      const [, payload] = vi.mocked(savePlaybackState).mock.calls[0];
      expect(payload?.queueSnapshot).toBeUndefined();
    });

    it("reports stale when the revision was superseded", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(savePlaybackState).mockResolvedValue(false);

      const result = await savePlaybackStateAction({
        provider: "mock",
        providerTrackId: "t-1",
        position: 42,
        revision: 1,
      });

      expect(result).toEqual({ ok: true, stale: true });
    });

    it("rejects invalid payloads without touching the database", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);

      expect(
        await savePlaybackStateAction({
          provider: "mock",
          providerTrackId: "",
          position: 1,
          revision: 0,
        }),
      ).toEqual({ ok: false });

      expect(
        await savePlaybackStateAction({
          provider: "mock",
          providerTrackId: "t-1",
          position: -5,
          revision: 0,
        }),
      ).toEqual({ ok: false });

      expect(
        await savePlaybackStateAction({
          provider: "",
          providerTrackId: "t-1",
          position: 1,
          revision: 0,
        }),
      ).toEqual({ ok: false });

      expect(savePlaybackState).not.toHaveBeenCalled();
    });

    it("migrates a v1 queue snapshot up to the current version for the DAL", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(savePlaybackState).mockResolvedValue(true);

      // A snapshot written by a Phase 40 build: no player preferences,
      // no staleness stamp. It must be accepted and upgraded, never
      // rejected (which would silently lose the user's queue).
      const queueSnapshot = {
        version: 1 as const,
        entries: [
          {
            provider: "mock",
            providerTrackId: "t-1",
            title: "Track",
            artistId: "a1",
            artistName: "Artist",
          },
        ],
        playOrder: [0],
        position: 0,
        mediaPosition: 10,
        shuffle: false,
        repeat: "off" as const,
      };
      const result = await savePlaybackStateAction({
        provider: "mock",
        providerTrackId: "t-1",
        position: 10,
        revision: 0,
        queueSnapshot,
      });

      expect(result).toEqual({ ok: true });
      expect(savePlaybackState).toHaveBeenCalledWith("user-1", {
        provider: "mock",
        providerTrackId: "t-1",
        position: 10,
        revision: 0,
        queueSnapshot: {
          version: QUEUE_SNAPSHOT_VERSION,
          entries: queueSnapshot.entries,
          playOrder: [0],
          position: 0,
          mediaPosition: 10,
          shuffle: false,
          repeat: "off",
          volume: 1,
          muted: false,
          savedAt: 0,
        },
      });
    });

    it("passes a current-version queue snapshot through to the DAL", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(savePlaybackState).mockResolvedValue(true);

      const queueSnapshot = {
        version: QUEUE_SNAPSHOT_VERSION,
        entries: [
          {
            provider: "mock",
            providerTrackId: "t-1",
            title: "Track",
            artistId: "a1",
            artistName: "Artist",
          },
        ],
        playOrder: [0],
        position: 0,
        mediaPosition: 10,
        shuffle: false,
        repeat: "off" as const,
        volume: 0.5,
        muted: true,
        savedAt: 1_700_000_000_000,
      };
      const result = await savePlaybackStateAction({
        provider: "mock",
        providerTrackId: "t-1",
        position: 10,
        revision: 0,
        queueSnapshot,
      });

      expect(result).toEqual({ ok: true });
      expect(savePlaybackState).toHaveBeenCalledWith("user-1", {
        provider: "mock",
        providerTrackId: "t-1",
        position: 10,
        revision: 0,
        queueSnapshot,
      });
    });

    it("rejects snapshots carrying playback-URL fields", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);

      const result = await savePlaybackStateAction({
        provider: "mock",
        providerTrackId: "t-1",
        position: 1,
        revision: 0,
        queueSnapshot: {
          version: 2,
          entries: [
            {
              provider: "mock",
              providerTrackId: "t-1",
              title: "Track",
              artistId: "a1",
              artistName: "Artist",
              streamUrl: "https://googlevideo.example/v",
            },
          ],
          playOrder: [0],
          position: 0,
          mediaPosition: 0,
          shuffle: false,
          repeat: "off",
        },
      });

      expect(result).toEqual({ ok: false });
      expect(savePlaybackState).not.toHaveBeenCalled();
    });

    it("derives identity from the session, never the client", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "real-user" } as never);
      vi.mocked(savePlaybackState).mockResolvedValue(true);

      await savePlaybackStateAction({
        provider: "mock",
        providerTrackId: "t-1",
        position: 1,
        revision: 0,
        userId: "attacker-chosen-id",
      });

      expect(savePlaybackState).toHaveBeenCalledWith(
        "real-user",
        expect.anything(),
      );
    });
  });

  describe("clearPlaybackStateAction", () => {
    it("clears only the authenticated user's state", async () => {
      vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
      vi.mocked(clearPlaybackState).mockResolvedValue(undefined);

      expect(await clearPlaybackStateAction()).toEqual({ ok: true });
      expect(clearPlaybackState).toHaveBeenCalledWith("user-1");
    });

    it("returns ok:false when unauthenticated", async () => {
      vi.mocked(requireUser).mockRejectedValue(new Error("nope"));

      expect(await clearPlaybackStateAction()).toEqual({ ok: false });
    });
  });

  describe("getSessionUserIdAction", () => {
    it("returns the session user id", async () => {
      vi.mocked(getSessionUserId).mockResolvedValue("user-9");

      expect(await getSessionUserIdAction()).toEqual({
        ok: true,
        userId: "user-9",
      });
    });

    it("returns null when anonymous", async () => {
      vi.mocked(getSessionUserId).mockResolvedValue(null);

      expect(await getSessionUserIdAction()).toEqual({
        ok: true,
        userId: null,
      });
    });
  });

  describe("resolvePlaybackTrackAction", () => {
    const provider = { id: "mock" };

    it("resolves through the exact provider", async () => {
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(fetchTrackDetail).mockResolvedValue({
        kind: "success",
        data: { id: "t-1", provider: "mock" },
      } as never);

      const result = await resolvePlaybackTrackAction("mock", "t-1");

      expect(getProvider).toHaveBeenCalledWith("mock");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.track).toEqual({ id: "t-1", provider: "mock" });
      }
    });

    it("warms the provider registry before resolving", async () => {
      // Regression: the registry is populated lazily by getShellProviders().
      // Without warming it here, a cold process whose first request happened
      // to be a page that never registers providers resolved nothing, and the
      // persistence layer treats an unresolvable persisted track as
      // permission to delete the user's saved session and queue.
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(fetchTrackDetail).mockResolvedValue({
        kind: "success",
        data: { id: "t-1", provider: "mock" },
      } as never);

      await resolvePlaybackTrackAction("mock", "t-1");

      expect(getShellProviders).toHaveBeenCalled();
    });

    it("returns null when the provider is unavailable", async () => {
      vi.mocked(getProvider).mockImplementation(() => {
        throw new Error("not registered");
      });

      const result = await resolvePlaybackTrackAction("jamendo", "t-1");

      expect(result).toEqual({ ok: true, track: null });
      expect(fetchTrackDetail).not.toHaveBeenCalled();
    });

    it("returns null when the provider lookup fails", async () => {
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(fetchTrackDetail).mockResolvedValue({ kind: "failed" } as never);

      expect(await resolvePlaybackTrackAction("mock", "gone")).toEqual({
        ok: true,
        track: null,
      });
    });

    it("rejects mismatched provider identity in the response", async () => {
      vi.mocked(getProvider).mockReturnValue(provider as never);
      vi.mocked(fetchTrackDetail).mockResolvedValue({
        kind: "success",
        data: { id: "t-1", provider: "jamendo" },
      } as never);

      expect(await resolvePlaybackTrackAction("mock", "t-1")).toEqual({
        ok: true,
        track: null,
      });
    });

    it("returns null for invalid input without throwing", async () => {
      expect(await resolvePlaybackTrackAction("", "")).toEqual({
        ok: true,
        track: null,
      });
      expect(await resolvePlaybackTrackAction("mock", "")).toEqual({
        ok: true,
        track: null,
      });
    });
  });
});
