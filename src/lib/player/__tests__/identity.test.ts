import { describe, expect, it } from "vitest";
import { trackKey } from "@/lib/player/identity";

/**
 * `trackKey` only. The former `sameTrack` helper was removed with no
 * production caller: `store.ts` and `engine.ts` compare keys rather than
 * comparing tracks field-by-field, so a second comparison primitive was a
 * second definition of the same thing that could drift.
 */
describe("trackKey", () => {
  it("combines provider and id into a stable identity", () => {
    expect(trackKey({ id: "123", provider: "youtube" })).toBe("youtube:123");
    expect(trackKey({ id: "123", provider: "spotify" })).toBe("spotify:123");
  });

  it("keeps same ids across different providers distinct", () => {
    expect(trackKey({ provider: "youtube", id: "42" })).not.toBe(
      trackKey({ provider: "spotify", id: "42" }),
    );
  });
});