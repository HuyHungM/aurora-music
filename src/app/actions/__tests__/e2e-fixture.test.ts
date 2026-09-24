import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getE2EPlaybackFixtureAction } from "@/app/actions/e2e-fixture";

const FLAG = "AURORA_E2E_LIVE_PLAYBACK";

describe("e2e-fixture gate", () => {
  const saved = process.env[FLAG];

  beforeEach(() => {
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = saved;
    }
  });

  it("reports disabled without the live flag (route 404s)", async () => {
    await expect(getE2EPlaybackFixtureAction("dQw4w9WgXcQ")).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("rejects malformed ids without touching the network", async () => {
    process.env[FLAG] = "1";
    await expect(getE2EPlaybackFixtureAction("not an id!!!")).resolves.toEqual({
      ok: false,
      reason: "invalid-id",
    });
    await expect(getE2EPlaybackFixtureAction(123)).resolves.toEqual({
      ok: false,
      reason: "invalid-id",
    });
  });
});
