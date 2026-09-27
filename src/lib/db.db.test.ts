import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Live-database tests for the shared adapter path (run under the DB config
 * only). Read-only by construction: `SELECT 1` and a lookup by a sentinel
 * unique key that no real account can hold.
 *
 * The second test is the one that matters for the production incident: the
 * failure happened inside `getUserByAccount()` -> `prisma.account.findUnique()`,
 * not on a bare `SELECT 1`, so the adapter path must be exercised directly.
 */
describe("database adapter", () => {
  it("connects and answers SELECT 1", async () => {
    const rows = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    expect(rows[0]?.ok).toBe(1);
  });

  it("runs the getUserByAccount account lookup", async () => {
    const account = await prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: "__aurora_smoke__",
          providerAccountId: "__aurora_smoke__",
        },
      },
      select: { id: true },
    });
    expect(account).toBeNull();
  });
});
