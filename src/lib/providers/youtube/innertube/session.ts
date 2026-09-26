/**
 * THE shared InnerTube session (Phase 55). Server-only.
 *
 * WHY THIS FILE EXISTS. Before Phase 55 there was exactly one `Innertube`
 * instance, held in a module-level variable inside
 * `playback/innertube-client.ts`, and it served playback resolution alone.
 * Discovery did not exist. When discovery was added, the obvious move — a
 * second `Innertube.create()` in a new module — would have produced two
 * sessions in one process, which is the specific duplication this phase
 * exists to remove. So the session MOVED here and both halves now import it.
 * There is exactly one `Innertube.create()` call in the repository and this
 * file owns it.
 *
 * WHY ONE SESSION IS SAFE TO SHARE. The session is anonymous: no login, no
 * cookies persisted, no user data, no per-user state. It carries the client
 * context and the generated visitor data that YouTube's own web player would
 * generate anyway, so discovery results are not a function of which user
 * asked. Nothing user-specific is stored on it, which is why L2 caching of
 * discovery results across users is safe (see `tiered-transport.ts`).
 *
 * LIFECYCLE. Lazy: the session is not created at import time, only on the
 * first request that needs it. A failed creation clears the slot so the next
 * call retries with a fresh session instead of replaying a cached rejection
 * forever. Safe to call concurrently — the promise is memoised, so N
 * simultaneous first-calls share one `create()`.
 *
 * `generate_session_locally: true` avoids an extra round-trip. It can fail on
 * an environment without the crypto the generator expects; that failure is
 * the same class as any other transient create failure and is retried by the
 * next caller, not special-cased here.
 */

import { Innertube } from "youtubei.js";
import type { Misc, YT } from "youtubei.js";
import { Platform } from "youtubei.js";
import vm from "node:vm";

type Format = Misc.Format;
type VideoInfo = YT.VideoInfo;

/**
 * The one session promise for the process. Exported as a factory rather than
 * the raw promise so tests can inject a session without touching this
 * module-level slot.
 */
export type SessionFactory = () => Promise<Innertube>;

let sharedSession: Promise<Innertube> | null = null;

/** Test hook: forgets the memoised session. Never used in production. */
export function resetSharedSession(): void {
  sharedSession = null;
}

function defaultSessionFactory(): Promise<Innertube> {
  if (!sharedSession) {
    sharedSession = Innertube.create({ generate_session_locally: true }).catch(
      (error: unknown) => {
        sharedSession = null;
        throw error;
      },
    );
  }
  return sharedSession;
}

export function sharedInnertubeSession(): Promise<Innertube> {
  return defaultSessionFactory();
}

// ---------------------------------------------------------------------------
// Player-script evaluator
//
// The deciphering player script that youtubei.js extracts has to be executed
// somewhere. Without an evaluator, stream URLs are never materialized. This
// lives here rather than in the playback client because the session is
// shared: the evaluator is a property of the session, not of one consumer.
// ---------------------------------------------------------------------------

type EvaluatorEnv = Record<string, string | number | boolean | null | undefined>;

let evaluatorInstalled = false;

/**
 * Installs the stdlib evaluator exactly once per process. Safe to call
 * repeatedly (dev HMR, tests); a frozen shim simply keeps failing closed.
 */
export function ensureJsEvaluator(): void {
  if (evaluatorInstalled) {
    return;
  }
  evaluatorInstalled = true;
  try {
    Platform.shim.eval = evaluatePlayerScript;
  } catch {
    evaluatorInstalled = false;
  }
}

/**
 * Runs a library-extracted player script in a bare `node:vm` context (no
 * Node globals) with a hard timeout. The generated script ends with a
 * top-level `return`, so it is wrapped in a function scope before running.
 * Anything unexpected fails closed (undefined) and the caller skips the
 * format.
 */
export function evaluatePlayerScript(
  data: { output: string },
  env: EvaluatorEnv,
): Record<string, unknown> | undefined {
  try {
    const context = vm.createContext({ ...env });
    const wrapped = `(function(){\n${data.output}\n})()`;
    const result = vm.runInContext(wrapped, context, { timeout: 5000 });
    return asRecord(result) ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared field readers
//
// youtubei.js payloads are UNTRUSTED INPUT, exactly like a provider HTTP
// response. Every field consumed anywhere in the InnerTube boundary is read
// through one of these, so a library upgrade or a YouTube markup change
// produces a typed error or a skipped item — never a TypeError thrown out of
// a property access deep in the stack.
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function asBoolean(value: unknown): boolean {
  return value === true;
}

/**
 * Reads a youtubei.js text value as a trimmed string.
 *
 * Three shapes are accepted, because InnerTube is inconsistent about which it
 * sends: a `Text` node with `.text`, a node that only implements `toString`,
 * and a bare string. The bare-string case is not hypothetical — `getInfo`'s
 * `basic_info.title` arrives as a plain string in some responses, and an
 * `asText` that only understood nodes would silently drop the title and the
 * channel name, which are the two fields every match and every displayed row
 * depends on.
 *
 * Returns undefined for absent, empty, or non-text values so a malformed node
 * degrades to "this field is missing" rather than to the string "[object
 * Object]".
 */
export function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return asNonEmptyString(value);
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = asNonEmptyString(record.text);
  if (direct) {
    return direct;
  }
  if (typeof record.toString === "function") {
    const rendered = asNonEmptyString(String(record));
    if (rendered && rendered !== "[object Object]") {
      return rendered;
    }
  }
  return undefined;
}

/** Formats a `MM:SS` / `H:MM:SS` label into milliseconds. */
export function parseDurationToMs(label: unknown): number | undefined {
  const text = asText(label);
  if (!text) {
    return undefined;
  }
  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return undefined;
  }
  let total = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return undefined;
    }
    total = total * 60 + Number(part);
  }
  return total > 0 ? total * 1000 : undefined;
}

/**
 * Reads the decipher-capable player object from a session using only runtime
 * validation. Returns undefined when the shape is unfamiliar so callers fail
 * closed into typed errors instead of throwing on library internals.
 */
export function sessionPlayer(session: unknown): unknown {
  const inner = asRecord(asRecord(session)?.session);
  return inner?.player;
}

// ---------------------------------------------------------------------------
// Format handling
// ---------------------------------------------------------------------------

export function toFormatCandidate(format: Format): {
  url: string;
  hasAudio: boolean;
  hasVideo: boolean;
  itag?: number;
  mimeType?: string;
  bitrate?: number;
  durationMs?: number;
} | null {
  const record = asRecord(format);
  const hasAudio = record?.has_audio === true;
  const hasVideo = record?.has_video === true;
  const url = asNonEmptyString(record?.url);
  // Ciphered formats carry no direct URL until deciphered (YouTube serves
  // `signature_cipher` + a decipher hook instead). They must pass the gate
  // here — the caller below deciphers and only usable URLs are surfaced.
  const decipherable = typeof record?.decipher === "function";
  if (!hasAudio || (!url && !decipherable)) {
    return null;
  }
  const candidate: {
    url: string;
    hasAudio: boolean;
    hasVideo: boolean;
    itag?: number;
    mimeType?: string;
    bitrate?: number;
    durationMs?: number;
  } = {
    url: url ?? "",
    hasAudio,
    hasVideo,
  };
  const itag = asPositiveInt(record?.itag);
  if (itag !== undefined) {
    candidate.itag = itag;
  }
  const mimeType = asNonEmptyString(record?.mime_type);
  if (mimeType) {
    candidate.mimeType = mimeType;
  }
  const bitrate = asPositiveInt(record?.bitrate);
  if (bitrate !== undefined) {
    candidate.bitrate = bitrate;
  }
  const durationMs = asPositiveInt(record?.approx_duration_ms);
  if (durationMs !== undefined) {
    candidate.durationMs = durationMs;
  }
  return candidate;
}

export async function decipherFormatUrl(
  format: Format,
  player: unknown,
): Promise<string | undefined> {
  try {
    const decipher = (format as unknown as { decipher?: unknown }).decipher;
    if (typeof decipher !== "function") {
      return undefined;
    }
    const url = await (decipher as (player?: unknown) => Promise<unknown>).call(
      format,
      player,
    );
    return asNonEmptyString(url);
  } catch {
    return undefined;
  }
}

export type { Format, VideoInfo };
