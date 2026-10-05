import { describe, expect, it } from "vitest";
import { AuroraError, AuthorizationError } from "@/lib/errors";
import {
  ExtractorError,
  NormalizationError,
  PlaybackResolutionError,
  TrackMatchError,
  TrackNotFoundError,
} from "@/lib/domain";
import { PlayerError } from "@/lib/player/engine";
import { toUserFacingError } from "@/lib/errors/user-error";
import { t } from "@/lib/i18n/translate";

const FORBIDDEN = [
  "googlevideo",
  "https://",
  "Bearer",
  "Cookie",
  "player_response",
  "signatureCipher",
  "at Object.",
];

function assertSanitized(message: string) {
  for (const marker of FORBIDDEN) {
    expect(message, marker).not.toContain(marker);
  }
}

describe("toUserFacingError", () => {
  it("passes PlayerError messages through with playback category", () => {
    const mapped = toUserFacingError(
      new PlayerError("unavailable", "This track can't be played right now."),
    );
    expect(mapped).toMatchObject({
      category: "playback-unavailable",
      code: "PLAYBACK_UNAVAILABLE",
      message: "This track can't be played right now.",
      retryable: true,
      preservePlayback: true,
    });
  });

  it("scrubs URLs even from passthrough messages", () => {
    const mapped = toUserFacingError(
      new PlayerError(
        "playback",
        "failed https://rr1---sn.googlevideo.com/videoplayback?sig=abc apiKey=1",
      ),
    );
    assertSanitized(mapped.message);
    expect(mapped.message).toContain("[removed]");
  });

  it("maps match-stage failures to provider-unavailable without retry", () => {
    const mapped = toUserFacingError(
      new PlaybackResolutionError(
        { provider: "spotify", providerTrackId: "x" },
        "match",
        "No playable source in this identity",
      ),
    );
    expect(mapped).toMatchObject({
      category: "provider-unavailable",
      code: "PROVIDER_UNAVAILABLE",
      retryable: false,
      preservePlayback: true,
    });
    assertSanitized(mapped.message);
  });

  it("maps retryable resolution failures to network", () => {
    const mapped = toUserFacingError(
      new PlaybackResolutionError(
        { provider: "youtube", providerTrackId: "v" },
        "resolve",
        "YouTube playback info failed",
        { retryable: true },
      ),
    );
    expect(mapped.category).toBe("network");
    expect(mapped.retryable).toBe(true);
  });

  it("maps extractor, validation, and lookup failures", () => {
    expect(
      toUserFacingError(
        new ExtractorError("youtube", "info", "reset", { retryable: true }),
      ).category,
    ).toBe("network");
    expect(
      toUserFacingError(new ExtractorError("youtube", "info", "bad")).category,
    ).toBe("provider-unavailable");
    expect(
      toUserFacingError(new NormalizationError("id", "bad")).category,
    ).toBe("validation");
    expect(
      toUserFacingError(
        new TrackNotFoundError({ provider: "youtube", providerTrackId: "x" }),
      ),
    ).toMatchObject({ category: "not-found", code: "NOT_FOUND" });
    expect(
      toUserFacingError(
        new TrackMatchError({ source: "youtube", id: "x" }, 0.1),
      ).category,
    ).toBe("provider-unavailable");
  });

  it("maps auth failures without leaking internals", () => {
    const mapped = toUserFacingError(new AuthorizationError("nope"));
    expect(mapped).toMatchObject({
      category: "authentication",
      code: "AUTH_REQUIRED",
    });
    assertSanitized(mapped.message);
    expect(toUserFacingError({ status: 403 }).category).toBe("authentication");
    expect(toUserFacingError({ status: 404 }).category).toBe("not-found");
  });

  it("distinguishes offline from generic network failures", () => {
    const offline = toUserFacingError(new TypeError("fetch failed"), {
      online: false,
    });
    expect(offline).toMatchObject({
      category: "offline",
      code: "OFFLINE",
      retryable: true,
    });
    const online = toUserFacingError(new TypeError("fetch failed"), {
      online: true,
    });
    expect(online.category).toBe("network");
    // Plain errors and strings with network wording map to network.
    expect(toUserFacingError(new Error("NetworkError boom")).category).toBe(
      "network",
    );
  });

  it("keeps the English offline message identical to the dictionary", () => {
    // The Phase 42 contract: `msg()` returns an English literal for English
    // callers and the dictionary for everyone else, so the two must not drift.
    // This one drifted before — the literal and `errors.offlineMessage` both said
    // playback requires an internet connection, which is false for a local file.
    const english = toUserFacingError(new TypeError("fetch failed"), {
      online: false,
    }).message;
    expect(english).toBe(t("en", "errors.offlineMessage"));

    const vietnamese = toUserFacingError(new TypeError("fetch failed"), {
      online: false,
    }, "vi").message;
    expect(vietnamese).toBe(t("vi", "errors.offlineMessage"));
  });

  it("never tells a listener that playback needs a connection", () => {
    // This taxonomy is reached from error boundaries, and the errors that land
    // here are request failures — not the player. A local file plays with no
    // connectivity, so a message claiming otherwise is wrong whatever the
    // failure was.
    for (const locale of ["en", "vi"] as const) {
      const message = toUserFacingError(
        new PlaybackResolutionError(
          { provider: "youtube", providerTrackId: "x" },
          "resolve",
          "boom",
          { retryable: true },
        ),
        { online: false },
        locale,
      ).message;
      expect(message, locale).not.toMatch(
        /requires an internet connection|needs internet|nghe nhạc cần/i,
      );
    }
  });

  it("maps unknown values to a safe default", () => {
    for (const value of [undefined, null, 42, {}, new AuroraError("x")]) {
      const mapped = toUserFacingError(value);
      expect(mapped).toMatchObject({
        category: "unknown",
        code: "UNKNOWN_ERROR",
        retryable: true,
        preservePlayback: true,
      });
      assertSanitized(mapped.message);
    }
  });

  it("never exposes secrets from hostile error shapes", () => {
    const hostile = new Error(
      "boom https://rr1.googlevideo.com/v?sig=abc Authorization: Bearer tok Cookie: sid=1 " +
        "apiKey=AIza123 player_response={} signatureCipher=x stack at Object.f (/a/b.js:1:2)",
    );
    const mapped = toUserFacingError(hostile);
    assertSanitized(mapped.message);
  });
});
