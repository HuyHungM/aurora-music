import { describe, expect, it } from "vitest";
import { isPortFree, waitForHealthy } from "../../../../scripts/smoke-prod.mjs";

function okResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

describe("waitForHealthy", () => {
  it("resolves true once readiness reports ok", async () => {
    let calls = 0;
    const result = await waitForHealthy("http://x", {
      timeoutMs: 1000,
      pollMs: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error(" refused");
        }
        return okResponse({ status: "ok" });
      },
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(result).toBe(true);
    expect(calls).toBe(3);
  });

  it("ignores non-ok readiness and fails closed on timeout", async () => {
    let now = 0;
    const result = await waitForHealthy("http://x", {
      timeoutMs: 100,
      pollMs: 10,
      fetchImpl: async () => okResponse({ status: "degraded" }),
      sleep: async () => {
        now += 200;
      },
      now: () => now,
    });
    expect(result).toBe(false);
  });
});

describe("isPortFree", () => {
  it("reports free only on connection refusal", async () => {
    const refused = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    expect(
      await isPortFree("http://x", async () => {
        throw refused;
      }),
    ).toBe(true);
    expect(
      await isPortFree("http://x", async () => okResponse({})),
    ).toBe(false);
  });

  it("reports free on Bun's connection-refusal shape (no cause)", async () => {
    // Phase 50. Bun's fetch rejects with the code directly on the error
    // ("ConnectionRefused") and no `cause`, unlike Node's
    // "fetch failed" + cause.code = "ECONNREFUSED".
    const refused = Object.assign(new TypeError("Unable to connect"), {
      code: "ConnectionRefused",
    });
    expect(
      await isPortFree("http://x", async () => {
        throw refused;
      }),
    ).toBe(true);
  });

  it("fails closed on ambiguous errors", async () => {
    expect(
      await isPortFree("http://x", async () => {
        throw new Error("TLS kaboom");
      }),
    ).toBe(false);
  });

  it("fails closed when only an unrelated code is present", async () => {
    // A non-refusal code must not be mistaken for a free port.
    const other = Object.assign(new Error("nope"), { code: "UND_ERR_SOCKET" });
    expect(
      await isPortFree("http://x", async () => {
        throw other;
      }),
    ).toBe(false);
  });
});
