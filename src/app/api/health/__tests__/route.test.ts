import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")),
  },
}));

import { GET } from "@/app/api/health/route";

describe("GET /api/health without a database", () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    if (savedDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = savedDatabaseUrl;
    }
  });

  it("reports degraded with a fixed minimal shape", async () => {
    // getEnv() needs a (dummy) URL to reach the database check; the
    // mocked client below is what actually fails.
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/aurora");
    const response = await GET();
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: "degraded",
      checks: { environment: "valid", database: "down" },
    });
  });

  it("serves repeated polls without accumulating state", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://test:test@localhost:5432/aurora");
    const { prisma: mocked } = await import("@/lib/db");
    const spy = mocked.$queryRaw as unknown as ReturnType<typeof vi.fn>;
    const before = spy.mock.calls.length;
    for (let index = 0; index < 25; index += 1) {
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: "degraded",
        checks: { environment: "valid", database: "down" },
      });
    }
    // Exactly one bounded probe per request: no retries, no leaks.
    expect(spy.mock.calls.length).toBe(before + 25);
  });
});
