import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { resolveLocale, type Locale } from "@/lib/i18n/locale";

/**
 * Authenticated language preference (Phase 42). A nullable `User.locale`
 * column — not a dedicated table — holds the explicit account choice.
 * Null means "no explicit preference" (falls back to cookie, then vi).
 */
export async function getUserLocale(
  userId: string,
  db: PrismaClient = prisma,
): Promise<Locale | null> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  });
  if (!row || row.locale == null) {
    return null;
  }
  return resolveLocale(row.locale);
}

export async function setUserLocale(
  userId: string,
  locale: Locale,
  db: PrismaClient = prisma,
): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { locale },
  });
}
