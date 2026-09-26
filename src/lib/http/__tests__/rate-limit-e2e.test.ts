import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The E2E stand-down for rate limiting (Phase 52, RULE 12).
 *
 * The rate limiter is deliberately inert when the process is running the E2E
 * fixture posture, because the harness replays many independent user journeys
 * as two synthetic users and would otherwise trip a ceiling no real person
 * reaches. That is a real decision with a real cost, so it gets its own tests
 * rather than being left as an untested branch in the guard:
 *
 *   - it works, and charges nothing rather than merely allowing;
 *   - it is OFF by default, i.e. the limiter still bites in every other
 *     environment;
 *   - it fails TOWARD enforcing when the environment cannot be read;
 *   - the decision it returns still tells the truth about the ceiling.
 */

const getEnv = vi.fn<() => { AURORA_E2E_AUTH?: string }>();

vi.mock("@/lib/config/env", () => ({
  getEnv: () => getEnv(),
}));

// The guard imports the session lookup at module scope, and that module reaches
// Prisma. Every test below passes `userId` explicitly, so the lookup is never
// used; stubbing it keeps this file about the limiter instead of standing up a
// database to answer a question about a Map.
vi.mock("@/lib/dal/session", () => ({
  getSessionUserId: async () => {
    throw new Error("the session lookup must not be reached in these tests");
  },
}));

// Imported after the mock so the guard sees the stubbed env.
const { guardRateLimit } = await import("@/lib/http/rate-limit-server");
const { RATE_LIMIT_BUCKETS, createFixedWindowLimiter } = await import(
  "@/lib/http/rate-limit"
);
const { RateLimitError } = await import("@/lib/api/error-codes");

const bucket = RATE_LIMIT_BUCKETS.radioStart;

function freshLimiter() {
  return createFixedWindowLimiter({ now: () => 0 });
}

describe("rate limiter under the E2E fixture posture", () => {
  beforeEach(() => {
    getEnv.mockReset();
  });

  it("enforces normally when the E2E flag is absent", async () => {
    getEnv.mockReturnValue({});
    const limiter = freshLimiter();
    // `userId` is passed explicitly so the guard never reaches the session
    // lookup: this test is about the limiter, not about Auth.js.
    const options = { userId: "user-1", limiter } as const;

    for (let i = 0; i < bucket.limit; i += 1) {
      const decision = await guardRateLimit("radioStart", options);
      expect(decision.allowed, `request ${i + 1} of the budget`).toBe(true);
    }
    await expect(guardRateLimit("radioStart", options)).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("enforces normally when the flag is set to anything but exactly \"1\"", async () => {
    // The same strict `=== "1"` comparison the fixture routes use. A stray
    // "true" must not silently disable a production protection.
    for (const value of ["true", "0", "", "yes", "1 "] as const) {
      getEnv.mockReturnValue({ AURORA_E2E_AUTH: value });
      const limiter = freshLimiter();
      const options = { userId: "user-1", limiter } as const;
      for (let i = 0; i < bucket.limit; i += 1) {
        await guardRateLimit("radioStart", options);
      }
      await expect(
        guardRateLimit("radioStart", options),
        `AURORA_E2E_AUTH=${JSON.stringify(value)} must not disable the limiter`,
      ).rejects.toBeInstanceOf(RateLimitError);
    }
  });

  it("stands down under the fixture posture, and charges nothing", async () => {
    getEnv.mockReturnValue({ AURORA_E2E_AUTH: "1" });
    const limiter = freshLimiter();
    const options = { userId: "user-1", limiter } as const;

    // Far beyond the real ceiling, which is the whole point: the harness
    // overshoots it by design.
    for (let i = 0; i < bucket.limit * 3; i += 1) {
      const decision = await guardRateLimit("radioStart", options);
      expect(decision.allowed, `burst request ${i + 1}`).toBe(true);
      // The configured ceiling is still reported truthfully, so a caller
      // reading `remaining` is not handed a number that means nothing.
      expect(decision.limit).toBe(bucket.limit);
      expect(decision.remaining).toBe(bucket.limit);
    }

    // "Allowed" alone would be indistinguishable from a very generous bucket.
    // Nothing was consumed, so nothing accumulated: an unbounded burst must
    // not grow the window map, which is what would exhaust memory.
    expect(limiter.size()).toBe(0);
  });

  it("fails toward enforcing when the environment cannot be read", async () => {
    getEnv.mockImplementation(() => {
      throw new Error("no environment");
    });
    const limiter = freshLimiter();
    const options = { userId: "user-1", limiter } as const;
    for (let i = 0; i < bucket.limit; i += 1) {
      await guardRateLimit("radioStart", options);
    }
    // An unreadable environment is not evidence of a test harness, so the
    // limiter must still bite.
    await expect(guardRateLimit("radioStart", options)).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });
});
