import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register } from "@/instrumentation";
import { setLogLevel, setLogSink } from "@/lib/diagnostics/logger";
import type { LogRecord } from "@/lib/diagnostics/logger";

const FLAG = "DATABASE_URL";

describe("server boot hook", () => {
  const saved = process.env[FLAG];
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
    if (saved === undefined) {
      delete process.env[FLAG];
    } else {
      process.env[FLAG] = saved;
    }
  });

  it("fails fast with a safe error when required config is missing", async () => {
    delete process.env[FLAG];
    await expect(register()).rejects.toThrow(/Invalid environment/);
    const errors = records.filter((record) => record.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toBe("configuration_error");
    const logged = JSON.stringify(records);
    expect(logged).not.toContain("postgres");
    expect(logged).not.toContain("DATABASE_URL=");
  });

  it("logs a sanitized startup summary when config is valid", async () => {
    process.env[FLAG] = "postgresql://user:secret@localhost:5432/aurora";
    await expect(register()).resolves.toBeUndefined();
    const started = records.filter((record) => record.event === "server_started");
    expect(started).toHaveLength(1);
    expect(started[0]?.fields).toMatchObject({ database: true });
    const logged = JSON.stringify(records);
    expect(logged).not.toContain("secret@localhost");
    expect(logged).not.toContain("postgresql://");
  });

  it("is safe to invoke repeatedly", async () => {
    process.env[FLAG] = "postgresql://user:secret@localhost:5432/aurora";
    await expect(register()).resolves.toBeUndefined();
    await expect(register()).resolves.toBeUndefined();
    const started = records.filter((record) => record.event === "server_started");
    expect(started).toHaveLength(2);
  });
});
