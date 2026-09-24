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
import { fetchTrackDetail } from "@/lib/providers/server";
import { getProvider } from "@/lib/providers/registry";
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
      });
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
