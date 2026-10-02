import { cache } from "react";
import type { User } from "@/lib/domain";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AuthenticationError } from "@/lib/errors";
import { mapUser, userColumns } from "@/lib/dal/mappers";

/**
 * The signed-in user for this request.
 *
 * `cache()`-wrapped for the same reason `getRequestLocale` and
 * `getRequestAppearance` are: layout and page both ask, so without it every
 * authenticated navigation read the user row twice. It is a request-scoped
 * memo, so a sign-out or user switch still takes effect on the next request.
 *
 * The `select` is the six fields `mapUser` reads. `appearance` is a JSON
 * column on this row that the mapper has always discarded.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return null;
  }
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: userColumns,
  });
  return row ? mapUser(row) : null;
});

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthenticationError();
  }
  return user;
}

/**
 * The signed-in user id, or null.
 *
 * `cache()`-wrapped for the same reason `getCurrentUser` is: `auth()` is not
 * memoized by next-auth with an object config, so every call re-reads headers
 * and re-decodes the session token. One navigation calls this three to four
 * times — the layout's `getCurrentUser`, `getRequestLocale`,
 * `getRequestAppearance`, and the page's own check — so the same JWT was being
 * verified and decoded that many times for one page view.
 */
export const getSessionUserId = cache(
  async (): Promise<string | null> => {
    const session = await auth();
    return session?.user?.id ?? null;
  },
);