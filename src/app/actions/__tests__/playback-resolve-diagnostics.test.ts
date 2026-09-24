import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAudioSourceAction } from "@/app/actions/playback-resolve";
import { setLogLevel, setLogSink } from "@/lib/diagnostics/logger";
import type { LogRecord } from "@/lib/diagnostics/logger";

vi.mock("@/lib/providers/youtube/playback/innertube-client", () => ({
  createInnertubePlaybackClient: () => ({
    getMediaInfo: async () => {
      throw new Error("boom https://evil.example/x?sig=abc");
    },
  }),
}));

describe("resolveAudioSourceAction diagnostics", () => {
  let records: LogRecord[] = [];
  let restoreSink: (() => void) | null = null;

  beforeEach(() => {
    records = [];
    setLogLevel("debug");
    restoreSink = setLogSink((record) => {
      records.push(record);
    });
  });

  afterEach(() => {
    restoreSink?.();
    restoreSink = null;
    setLogLevel("error");
  });

  it("logs structured failures without URLs and keeps the safe result", async () => {
    const result = await resolveAudioSourceAction("youtube", "dQw4w9WgXcQ");
    expect(result.ok).toBe(false);

    const failures = records.filter(
      (record) => record.event === "playback_resolution_failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: "error",
      fields: expect.objectContaining({
        provider: "youtube",
        operation: "innertube_resolve",
        videoId: "dQw4w9WgXcQ",
        errorCode: "PLAYBACK_RESOLUTION_ERROR",
        retryable: true,
      }),
    });
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain("evil.example");
    }
  });
});
