import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logger,
  sanitizeMessage,
  setLogLevel,
  setLogSink,
} from "@/lib/diagnostics/logger";
import type { LogRecord } from "@/lib/diagnostics/logger";

function capture() {
  const records: LogRecord[] = [];
  const restoreSink = setLogSink((record) => {
    records.push(record);
  });
  return { records, restoreSink };
}

afterEach(() => {
  setLogLevel("error");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("logger levels", () => {
  it("emits only records at or above the threshold", () => {
    const { records, restoreSink } = capture();
    try {
      setLogLevel("warn");
      logger.debug("d", { event: "e" });
      logger.info("i", { event: "e" });
      logger.warn("w", { event: "e" });
      logger.error("e", { event: "e" });
      expect(records.map((record) => record.level)).toEqual(["warn", "error"]);
    } finally {
      restoreSink();
    }
  });

  it("restores the previous sink", () => {
    const { records, restoreSink } = capture();
    setLogLevel("debug");
    logger.info("one", { event: "e" });
    restoreSink();
    logger.info("two", { event: "e" });
    expect(records).toHaveLength(1);
    setLogLevel("error");
  });

  it("produces structured records with timestamps", () => {
    const { records, restoreSink } = capture();
    try {
      setLogLevel("debug");
      logger.info("Playback recovery succeeded", {
        event: "playback_recovery_succeeded",
        trackKey: "youtube:abc",
        attempts: 1,
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        level: "info",
        event: "playback_recovery_succeeded",
        message: "Playback recovery succeeded",
        fields: { trackKey: "youtube:abc", attempts: 1 },
      });
      expect(typeof records[0]?.timestamp).toBe("string");
    } finally {
      restoreSink();
    }
  });
});

describe("logger redaction", () => {
  it("drops forbidden fields and keeps safe ones", () => {
    const { records, restoreSink } = capture();
    try {
      setLogLevel("debug");
      logger.error("x", {
        event: "e",
        provider: "youtube",
        videoId: "abc",
        authToken: "tok",
        cookie: "sid=1",
        streamUrl: "https://cdn.example/x",
        secret: "s",
      });
      expect(records[0]?.fields).toEqual({
        event: "e",
        provider: "youtube",
        videoId: "abc",
      });
    } finally {
      restoreSink();
    }
  });

  it("redacts URL shapes from messages and values", () => {
    expect(
      sanitizeMessage("failed https://rr1.googlevideo.com/v?sig=abc done"),
    ).toBe("failed [redacted-url] done");
    const { records, restoreSink } = capture();
    try {
      setLogLevel("debug");
      logger.warn("w", {
        event: "e",
        operation: "resolve",
        detail: "see https://cdn.example/x",
      });
      expect(records[0]?.fields.detail).toBe("see [redacted-url]");
    } finally {
      restoreSink();
    }
  });

  it("passes reviewed boolean presence flags but never their values", () => {
    const { records, restoreSink } = capture();
    try {
      setLogLevel("debug");
      logger.info("Server starting", {
        event: "server_started",
        database: true,
        authSecret: false,
        youtube: true,
        spotify: "yes" as unknown as boolean,
      });
      expect(records[0]?.fields).toEqual({
        event: "server_started",
        database: true,
        authSecret: false,
        youtube: true,
        spotify: null,
      });
    } finally {
      restoreSink();
    }
  });

  it("never throws on hostile input", () => {
    const { records, restoreSink } = capture();
    try {
      setLogLevel("debug");
      expect(() =>
        logger.error("x", {
          event: "e",
          weird: { nested: true } as unknown as string,
        }),
      ).not.toThrow();
      expect(records).toHaveLength(1);
      expect(records[0]?.fields.weird).toBeNull();
    } finally {
      restoreSink();
    }
  });
});

describe("logger defaults", () => {
  it("writes to console without a custom sink", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setLogLevel("error");
      logger.error("boom", { event: "e" });
      expect(errorSpy).toHaveBeenCalledOnce();
      const line = String(errorSpy.mock.calls[0]?.[0] ?? "");
      expect(() => JSON.parse(line)).not.toThrow();
      expect(JSON.parse(line)).toMatchObject({ level: "error", event: "e" });
    } finally {
      errorSpy.mockRestore();
      setLogLevel("error");
    }
  });
});
