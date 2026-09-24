import { describe, expect, it } from "vitest";
import { getAuthAvailability } from "@/lib/auth/availability";

const baseEnv = {
  AUTH_GOOGLE_ID: undefined,
  AUTH_GOOGLE_SECRET: undefined,
  AUTH_GITHUB_ID: undefined,
  AUTH_GITHUB_SECRET: undefined,
};

describe("getAuthAvailability", () => {
  it("reports nothing configured with empty credentials", () => {
    expect(getAuthAvailability(baseEnv)).toEqual({ google: false, github: false, configured: false });
  });

  it("enables google only when both id and secret are present", () => {
    expect(
      getAuthAvailability({ ...baseEnv, AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" }),
    ).toEqual({ google: true, github: false, configured: true });
  });

  it("enables github only when both id and secret are present", () => {
    expect(
      getAuthAvailability({ ...baseEnv, AUTH_GITHUB_ID: "id", AUTH_GITHUB_SECRET: "secret" }),
    ).toEqual({ google: false, github: true, configured: true });
  });

  it("requires a secret too, not just an id", () => {
    expect(getAuthAvailability({ ...baseEnv, AUTH_GOOGLE_ID: "id" })).toEqual({
      google: false,
      github: false,
      configured: false,
    });
  });

  it("reports configured when at least one provider is available", () => {
    expect(
      getAuthAvailability({
        ...baseEnv,
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
        AUTH_GITHUB_ID: "id",
        AUTH_GITHUB_SECRET: "secret",
      }),
    ).toEqual({ google: true, github: true, configured: true });
  });
});