/**
 * Minimal production-safe structured logger (Phase 25).
 *
 * Design rules:
 * - Synchronous console output only. No timers, no subscriptions, no
 *   buffering, no remote collector, no persistence. There is deliberately
 *   no telemetry sink: production observability here means readable local
 *   logs, nothing more.
 * - Structured fields are primitives chosen explicitly at each call site
 *   (allowlisted by construction). As a safety net, forbidden keys are
 *   dropped and URL-shaped values are redacted, so a future sloppy call
 *   site still cannot leak playback URLs or credentials.
 * - Level threshold: production emits info and above; test env emits
 *   error and above (quiet suites); anything else emits everything.
 *   Tests override explicitly via setLogLevel/setLogSink.
 * - Client-safe: no Node APIs, tiny enough for any bundle. Importing this
 *   module has no side effects beyond reading NODE_ENV once.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFieldValue = string | number | boolean | null | undefined;

export type LogFields = Record<string, LogFieldValue>;

export interface LogRecord {
  level: LogLevel;
  event: string;
  message: string;
  timestamp: string;
  fields: Record<string, string | number | boolean | null>;
}

/** Field names that must never enter a log record. */
const FORBIDDEN_FIELD_PATTERN =
  /secret|token|passwd|password|cookie|authori|credential|session|private[_-]?key|api[_-]?key|apikey|database|connectionstring/i;

/** Any key shaped like a URL holder is dropped fail-closed. */
const URL_FIELD_PATTERN = /url$/i;

/**
 * Exact configuration-presence flags. These names would otherwise trip
 * the deny list, but they are reviewed safe: values are coerced to
 * booleans, so they carry presence (1 bit), never secret content.
 */
const BOOLEAN_FLAG_FIELDS = new Set([
  "database",
  "authSecret",
  "youtube",
  "spotify",
]);

const URL_VALUE_PATTERN = /https?:\/\/\S+/gi;

function sanitizeValue(value: LogFieldValue): string | number | boolean | null {
  if (typeof value === "string") {
    return value.replace(URL_VALUE_PATTERN, "[redacted-url]");
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  // Anything else (objects, NaN, undefined smuggled past the types)
  // collapses to null: JSON-safe and leak-free by construction.
  return null;
}

function sanitizeFields(fields: LogFields): LogRecord["fields"] {
  const clean: LogRecord["fields"] = {};
  for (const [key, value] of Object.entries(fields)) {
    if (BOOLEAN_FLAG_FIELDS.has(key)) {
      clean[key] = typeof value === "boolean" ? value : null;
      continue;
    }
    if (FORBIDDEN_FIELD_PATTERN.test(key) || URL_FIELD_PATTERN.test(key)) {
      continue;
    }
    clean[key] = sanitizeValue(value);
  }
  return clean;
}

export function sanitizeMessage(message: string): string {
  return message.replace(URL_VALUE_PATTERN, "[redacted-url]");
}

function defaultThreshold(): LogLevel {
  const env =
    typeof process !== "undefined"
      ? (process.env?.NODE_ENV as string | undefined)
      : undefined;
  if (env === "production") {
    return "info";
  }
  if (env === "test") {
    return "error";
  }
  return "debug";
}

type LogSink = (record: LogRecord) => void;

function consoleSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "error") {
    console.error(line);
  } else if (record.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

let threshold: LogLevel = defaultThreshold();
let sink: LogSink = consoleSink;

/** Override the level threshold (tests use this for determinism). */
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** Replace the sink (tests capture records here). Returns a restore fn. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function emit(
  level: LogLevel,
  event: string,
  message: string,
  fields: LogFields = {},
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) {
    return;
  }
  try {
    sink({
      level,
      event,
      message: sanitizeMessage(message),
      timestamp: new Date().toISOString(),
      fields: sanitizeFields(fields),
    });
  } catch {
    // Diagnostics must never break the application.
  }
}

export const logger = {
  debug: (message: string, fields: LogFields & { event: string }) =>
    emit("debug", fields.event, message, fields),
  info: (message: string, fields: LogFields & { event: string }) =>
    emit("info", fields.event, message, fields),
  warn: (message: string, fields: LogFields & { event: string }) =>
    emit("warn", fields.event, message, fields),
  error: (message: string, fields: LogFields & { event: string }) =>
    emit("error", fields.event, message, fields),
};
