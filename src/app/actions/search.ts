"use server";

import { getSessionUserId } from "@/lib/dal/session";
import { addSearch, clearSearchHistory } from "@/lib/dal/search-history";
import { searchQuerySchema } from "@/lib/validation/schemas";

export async function recordSearchAction(query: string): Promise<void> {
  const userId = await getSessionUserId();
  if (!userId) return;
  const parsed = searchQuerySchema.safeParse({ query, limit: 20, offset: 0 });
  if (!parsed.success) return;
  await addSearch(userId, parsed.data.query);
}

export async function clearSearchHistoryAction(): Promise<void> {
  const userId = await getSessionUserId();
  if (!userId) return;
  await clearSearchHistory(userId);
}
