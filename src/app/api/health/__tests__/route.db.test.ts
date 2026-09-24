import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

/**
 * Live-database health tests (run under the DB config only).
 */
describe("GET /api/health", () => {
  it("reports ready with a fixed minimal shape", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["checks", "status"]);
    expect(body).toEqual({
      status: "ok",
      checks: { environment: "valid", database: "up" },
    });
  });

  it("exposes no secrets, paths, or provider data", async () => {
    const response = await GET();
    const text = JSON.stringify(await response.json());
    expect(text).not.toMatch(
      /secret|token|password|DATABASE_URL|youtube|spotify|googlevideo|prisma|\.ts|\//i,
    );
  });
});
