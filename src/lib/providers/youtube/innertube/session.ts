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
 * EGRESS. `installYouTubeEgress()` runs first and, only when a proxy is
 * configured, replaces the platform shim's fetch/Request/Headers before
 * `create()`. youtubei.js captures `Platform.shim.fetch` when it builds its
 * HTTP client, so the order matters; unset, the shim is left untouched. See
 * `egress.ts`.
 *
 * `generate_session_locally: true` avoids an extra round-trip. It can fail on
 * an environment without the crypto the generator expects; that failure is
 * the same class as any other transient create failure and is retried by the
 * next caller, not special-cased here.
 *
 * TEMPORARY DUAL-EGRESS EXCEPTION. Playback failover keeps one session per
 * configured egress so primary and secondary can use different proxies at the
 * same time. Discovery keeps using the shared session below. This is an
 * explicitly temporary workaround; the no-second-session rule in
 * `docs/scope-boundaries.md` is otherwise unchanged.
 */

import { Innertube } from "youtubei.js";
import type { Misc, YT } from "youtubei.js";
import { Platform } from "youtubei.js";
import vm from "node:vm";
import { installYouTubeEgress } from "./egress";

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
    sharedSession = installYouTubeEgress()
      .then(() => Innertube.create({ generate_session_locally: true }))
      .catch((error: unknown) => {
        sharedSession = null;
        throw error;
      });
  }
  return sharedSession;
}

export function sharedInnertubeSession(): Promise<Innertube> {
  return defaultSessionFactory();
}

/**
 * Constructs one playback-only InnerTube session bound to an explicit fetch
 * implementation (normally a proxy-dispatched fetch from `egress.ts`).
 *
 * The caller memoises the result per egress. No proxy URL, credential, or
 * request payload is accepted or logged here; this is only the single
 * repository seam where a session may be constructed.
 */
export function createProxyInnertubeSession(
  fetchFn: typeof fetch,
): Promise<Innertube> {
  return Innertube.create({ generate_session_locally: true, fetch: fetchFn });
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

export interface FormatCandidate {
  url: string;
  hasAudio: boolean;
  hasVideo: boolean;
  itag?: number;
  mimeType?: string;
  bitrate?: number;
  durationMs?: number;
  /** Diagnostics: the raw format already carried a usable direct URL. */
  directUrlPresent: boolean;
  /** Diagnostics: the raw format carried a signature/cipher payload to decipher. */
  cipherPresent: boolean;
}

/**
 * Admits a format only when it actually carries something usable.
 *
 * The previous gate treated `typeof format.decipher === "function"` as proof
 * of a decipherable payload. That is wrong: `decipher` is a prototype method
 * that exists on every `Format` whether or not this specific entry has a URL
 * or a cipher. A format with neither passed the gate and then failed inside
 * `decipherFormatUrl` (swallowed), which is how a response with formats still
 * produced zero candidates with no reason. The honest test is the payload
 * youtubei.js@18.0.0 actually exposes: a direct `url`, a `signature_cipher`,
 * or a `cipher` (Format.js copies `data.url`, `data.signatureCipher`, and
 * `data.cipher` verbatim).
 */
export function toFormatCandidate(format: Format): FormatCandidate | null {
  const record = asRecord(format);
  const hasAudio = record?.has_audio === true;
  const hasVideo = record?.has_video === true;
  const directUrl = asNonEmptyString(record?.url);
  const signatureCipher = asNonEmptyString(record?.signature_cipher);
  const cipher = asNonEmptyString(record?.cipher);
  const cipherPresent = signatureCipher !== undefined || cipher !== undefined;
  if (!hasAudio || (directUrl === undefined && !cipherPresent)) {
    return null;
  }
  const candidate: FormatCandidate = {
    url: directUrl ?? "",
    hasAudio,
    hasVideo,
    directUrlPresent: directUrl !== undefined,
    cipherPresent,
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

/** Why a ciphered format produced no direct URL. */
export type DecipherFailureReason =
  | "no_decipher_method"
  | "decipher_threw"
  | "empty_url";

export interface DecipherOutcome {
  url?: string;
  failure?: {
    reason: DecipherFailureReason;
    errorName?: string;
    errorMessage?: string;
  };
}

/**
 * Resolves a format's playable URL through youtubei.js's supported decipher
 * mechanism (`format.decipher(player)`), which returns a direct URL unchanged
 * or performs the signature/`n` transform for a ciphered format.
 *
 * A failure is returned as data, never swallowed into `undefined` with no
 * provenance: the caller records the reason/class/message in structured
 * diagnostics. The message is never a media URL on success; on failure it is
 * the library's own error text, which the logger additionally URL-redacts.
 */
export async function decipherFormatUrl(
  format: Format,
  player: unknown,
): Promise<DecipherOutcome> {
  const decipher = (format as unknown as { decipher?: unknown }).decipher;
  if (typeof decipher !== "function") {
    return { failure: { reason: "no_decipher_method" } };
  }
  try {
    const url = await (decipher as (player?: unknown) => Promise<unknown>).call(
      format,
      player,
    );
    const resolved = asNonEmptyString(url);
    if (!resolved) {
      return { failure: { reason: "empty_url" } };
    }
    return { url: resolved };
  } catch (error) {
    return {
      failure: {
        reason: "decipher_threw",
        errorName: error instanceof Error ? error.name : undefined,
        errorMessage: error instanceof Error ? error.message : undefined,
      },
    };
  }
}

export type { Format, VideoInfo };
