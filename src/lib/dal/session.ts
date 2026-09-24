import type { User } from "@/lib/domain";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { AuthenticationError } from "@/lib/errors";
import { mapUser } from "@/lib/dal/mappers";

export async function getCurrentUser(): Promise<User | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return null;
  }
  const row = await prisma.user.findUnique({ where: { id: userId } });
  return row ? mapUser(row) : null;
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthenticationError();
  }
  return user;
}

export async function getSessionUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}