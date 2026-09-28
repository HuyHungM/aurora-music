"use server";

import { getCurrentUser } from "@/lib/dal/session";
import { addSearch, clearSearchHistory } from "@/lib/dal/search-history";
import { searchQuerySchema } from "@/lib/validation/schemas";

/**
 * Search-history writes.
 *
 * Both actions are best-effort: `RecordSearch` calls `recordSearchAction` on
 * every search-page mount and discards the result, and `SearchHistorySection`
 * awaits `clearSearchHistoryAction` inside a transition. Neither caller handles
 * a rejection, so neither action may throw.
 *
 * They are also mutations, and the architecture rule (ARCHITECTURE §14) is that
 * a mutation resolves a *verified* user. The JWT session strategy means a
 * cookie can outlive its `User` row — a local DB reset/reseed or an account
 * deletion leaves the token intact — and `SearchHistory.userId` is a foreign
 * key. Reading the id straight from the token (`getSessionUserId`) would let
 * that stale id reach `searchHistory.create`, which fails
 * `SearchHistory_userId_fkey` and surfaces the raw Prisma error in the page.
 * `getCurrentUser` resolves the session against the database and returns null
 * when the row is gone, so the write is simply skipped.
 */

export async function recordSearchAction(query: string): Promise<void> {
  const parsed = searchQuerySchema.safeParse({ query, limit: 20, offset: 0 });
  if (!parsed.success) return;
  try {
    const user = await getCurrentUser().catch(() => null);
    if (!user) return;
    await addSearch(user.id, parsed.data.query);
  } catch {
    // History is a convenience; a failed write must not break the page.
  }
}

export async function clearSearchHistoryAction(): Promise<void> {
  try {
    const user = await getCurrentUser().catch(() => null);
    if (!user) return;
    await clearSearchHistory(user.id);
  } catch {
    // History is a convenience; a failed clear must not break the page.
  }
}
