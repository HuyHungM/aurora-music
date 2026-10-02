import { describe, expect, it } from "vitest";
import {
  ensureJsEvaluator,
  evaluatePlayerScript,
  sessionPlayer,
} from "@/lib/providers/youtube/innertube/session";

/**
 * Session-owned helpers, tested where they live.
 *
 * These three used to be exercised from
 * `youtube/playback/__tests__/innertube-client.test.ts` through a
 * "re-exported for compatibility" block in `playback/innertube-client.ts`.
 * That block had no consumer other than that test file, so it was removed and
 * the coverage moved here: the helpers belong to the shared session, not to
 * the playback half, and `innertube/session.ts` had no test file of its own.
 */
describe("player script evaluator", () => {
  it("evaluates extracted scripts in an isolated context", () => {
    expect(
      evaluatePlayerScript({ output: "return { sig: 'abc', n: '1' };" }, { s: "x" }),
    ).toEqual({ sig: "abc", n: "1" });
  });

  it("fails closed on non-object or throwing scripts", () => {
    expect(
      evaluatePlayerScript({ output: "(() => { throw new Error('x'); })()" }, {}),
    ).toBeUndefined();
    expect(evaluatePlayerScript({ output: "42" }, {})).toBeUndefined();
  });

  it("reads the nested session player without touching internals blindly", () => {
    const player = { signature_timestamp: 1 };
    expect(sessionPlayer({ session: { player } })).toBe(player);
    expect(sessionPlayer({})).toBeUndefined();
    expect(sessionPlayer(null)).toBeUndefined();
  });

  it("installs the evaluator idempotently", () => {
    expect(() => {
      ensureJsEvaluator();
      ensureJsEvaluator();
    }).not.toThrow();
  });
});