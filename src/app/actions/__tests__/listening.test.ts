import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dal/session", () => ({
  requireUser: vi.fn(),
  getSessionUserId: vi.fn(),
}));

vi.mock("@/lib/dal/listening", () => ({
  getKeepListening: vi.fn(),
  setKeepListening: vi.fn(),
}));

import { requireUser, getSessionUserId } from "@/lib/dal/session";
import { getKeepListening, setKeepListening } from "@/lib/dal/listening";
import {
  getKeepListeningAction,
  setKeepListeningAction,
} from "../listening";

/**
 * Phase 47 "Keep listening" preference action boundary.
 *
 * The read must fail SAFE (OFF, not ON) for an anonymous visitor and for a
 * failing database: defaulting to ON would silently start generating tracks
 * for someone who never asked for it. The write must fail CLOSED for an
 * anonymous caller.
 */

const mockUser = { id: "user-1" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSessionUserId).mockResolvedValue("user-1");
  vi.mocked(requireUser).mockResolvedValue(mockUser);
  vi.mocked(getKeepListening).mockResolvedValue(false);
  vi.mocked(setKeepListening).mockResolvedValue(false);
});

describe("getKeepListeningAction", () => {
  it("returns the stored preference for a signed-in listener", async () => {
    vi.mocked(getKeepListening).mockResolvedValue(true);
    await expect(getKeepListeningAction()).resolves.toEqual({
      ok: true,
      enabled: true,
      authenticated: true,
    });
  });

  it("resolves OFF for an anonymous visitor without touching the database", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null);
    await expect(getKeepListeningAction()).resolves.toEqual({
      ok: true,
      enabled: false,
      authenticated: false,
    });
    expect(getKeepListening).not.toHaveBeenCalled();
  });

  it("resolves OFF when the session lookup itself throws", async () => {
    vi.mocked(getSessionUserId).mockRejectedValue(new Error("no cookie"));
    await expect(getKeepListeningAction()).resolves.toEqual({
      ok: true,
      enabled: false,
      authenticated: false,
    });
  });

  // A database failure must never be read as an enabled preference: that
  // would turn an outage into unsolicited queue generation.
  it("resolves OFF when the preference read fails, and says it is authenticated", async () => {
    vi.mocked(getKeepListening).mockRejectedValue(new Error("db down"));
    await expect(getKeepListeningAction()).resolves.toEqual({
      ok: true,
      enabled: false,
      authenticated: true,
    });
  });
});

describe("setKeepListeningAction", () => {
  it("persists the preference for a signed-in listener", async () => {
    vi.mocked(setKeepListening).mockResolvedValue(true);
    await expect(setKeepListeningAction(true)).resolves.toEqual({
      ok: true,
      enabled: true,
    });
    expect(setKeepListening).toHaveBeenCalledWith("user-1", true);
  });

  it("can turn the preference off again", async () => {
    vi.mocked(setKeepListening).mockResolvedValue(false);
    await expect(setKeepListeningAction(false)).resolves.toEqual({
      ok: true,
      enabled: false,
    });
    expect(setKeepListening).toHaveBeenCalledWith("user-1", false);
  });

  // Fail closed: an anonymous caller gets an error, not a silent success.
  it("refuses an anonymous caller and never reaches the database", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("Unauthorized"));
    const result = await setKeepListeningAction(true);
    expect(result.ok).toBe(false);
    expect(setKeepListening).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean payload", async () => {
    for (const value of ["true", 1, null, undefined, {}, []]) {
      const result = await setKeepListeningAction(value);
      expect(result.ok, String(value)).toBe(false);
    }
    expect(setKeepListening).not.toHaveBeenCalled();
  });

  it("reports a database failure as an error, not a phantom success", async () => {
    vi.mocked(setKeepListening).mockRejectedValue(new Error("db down"));
    const result = await setKeepListeningAction(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Failed to update preference");
    }
  });
});
