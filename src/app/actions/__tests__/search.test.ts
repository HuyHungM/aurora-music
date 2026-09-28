import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Search-history write guard (ARCHITECTURE §14: mutations resolve a verified
 * user).
 *
 * `SearchHistory.userId` is a foreign key, but the session is a JWT: a cookie
 * can outlive its `User` row (local DB reset/reseed, or account deletion).
 * `recordSearchAction` is fire-and-forget and its caller discards the result,
 * so a stale id used to reach `searchHistory.create` and blow up the search
 * page with `SearchHistory_userId_fkey`. The action must resolve the session
 * against the database (`getCurrentUser`), skip the write when the row is gone,
 * and never reject.
 */

vi.mock("@/lib/dal/session", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/dal/search-history", () => ({
  addSearch: vi.fn(),
  clearSearchHistory: vi.fn(),
}));

import { getCurrentUser } from "@/lib/dal/session";
import { addSearch, clearSearchHistory } from "@/lib/dal/search-history";
import { recordSearchAction, clearSearchHistoryAction } from "../search";

const mockUser = { id: "user-1" } as never;

describe("recordSearchAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentUser).mockResolvedValue(mockUser);
    vi.mocked(addSearch).mockResolvedValue(undefined as never);
  });

  it("records a valid query for a verified user", async () => {
    await recordSearchAction("  jazz  ");
    expect(getCurrentUser).toHaveBeenCalledTimes(1);
    expect(addSearch).toHaveBeenCalledWith("user-1", "jazz");
  });

  it("skips an empty or whitespace-only query", async () => {
    await recordSearchAction("   ");
    expect(addSearch).not.toHaveBeenCalled();
  });

  it("skips a query beyond the length bound", async () => {
    await recordSearchAction("x".repeat(201));
    expect(addSearch).not.toHaveBeenCalled();
  });

  it("skips the write when the JWT references a user that no longer exists", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    await expect(recordSearchAction("jazz")).resolves.toBeUndefined();
    expect(addSearch).not.toHaveBeenCalled();
  });

  it("never rejects when the session lookup fails", async () => {
    vi.mocked(getCurrentUser).mockRejectedValue(new Error("session store down"));
    await expect(recordSearchAction("jazz")).resolves.toBeUndefined();
    expect(addSearch).not.toHaveBeenCalled();
  });

  it("never rejects when the write itself fails", async () => {
    vi.mocked(addSearch).mockRejectedValue(new Error("P2003"));
    await expect(recordSearchAction("jazz")).resolves.toBeUndefined();
  });
});

describe("clearSearchHistoryAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentUser).mockResolvedValue(mockUser);
    vi.mocked(clearSearchHistory).mockResolvedValue(undefined as never);
  });

  it("clears history for a verified user", async () => {
    await clearSearchHistoryAction();
    expect(clearSearchHistory).toHaveBeenCalledWith("user-1");
  });

  it("skips when the JWT references a user that no longer exists", async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    await expect(clearSearchHistoryAction()).resolves.toBeUndefined();
    expect(clearSearchHistory).not.toHaveBeenCalled();
  });

  it("never rejects when the clear fails", async () => {
    vi.mocked(clearSearchHistory).mockRejectedValue(new Error("db down"));
    await expect(clearSearchHistoryAction()).resolves.toBeUndefined();
  });
});
