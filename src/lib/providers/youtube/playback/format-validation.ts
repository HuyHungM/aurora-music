/**
 * Server-side format validation for YouTube playback resolution.
 *
 * SERVER-ONLY. Resolution success does not prove the browser can consume
 * the URL: YouTube's adaptive (DASH) audio URLs refuse any request that would
 * return the whole body (`Range: bytes=0-`, no `Range` at all, or `HEAD`) with
 * HTTP 403, while a bounded range returns 206 from the same URL. A browser
 * media element always issues the whole-body form first, so Chromium reports
 * ERR_BLOCKED_BY_ORB and then MEDIA_ERR_SRC_NOT_SUPPORTED (code 4) even though
 * the resolver handed out a well-formed AudioSource. Measured across every
 * video sampled on 2026-09-26: this affects the adaptive audio ladder of all
 * but one, and the progressive (muxed) format of the same video is unaffected.
 * See ARCHITECTURE.md 7 "Browser-shaped range validation".
 *
 * The probe therefore mirrors the browser's first request — open-ended range,
 * status only, body cancelled immediately — and predicts browser playability
 * without downloading media. It never logs or returns the URL.
 *
 * A 403 alone cannot distinguish a dead URL (expired signature) from the
 * whole-body refusal above, so a rejected 403/416 is confirmed with ONE extra
 * bounded request. That confirmation is DIAGNOSTIC ONLY: it never promotes an
 * unconsumable candidate, because the browser would still fail on it. It
 * exists so the log can state which of the two happened instead of leaving an
 * operator to guess, which is what made this undiagnosable in the first place.
 */

/** How long one format probe may take before the candidate is skipped. */
export const FORMAT_VALIDATE_TIMEOUT_MS = 5000;

/** The request shape a browser media element sends first. */
const WHOLE_BODY_RANGE = "bytes=0-";

/** A small bounded read, used only to tell a dead URL from a whole-body refusal. */
const BOUNDED_CONFIRM_RANGE = "bytes=0-1023";

/**
 * Stable, machine-readable reason a candidate was rejected. Chosen so a log
 * consumer can group failures without parsing prose, and so "the CDN refuses
 * whole-body reads" stays distinguishable from "this URL is dead".
 */
export type FormatProbeReason =
  | "consumable"
  | "missing_url"
  | "probe_timeout"
  | "probe_network_error"
  | "probe_status_403"
  | "probe_status_404"
  | "probe_status_416"
  | "probe_status_other"
  | "validator_injected";

export interface FormatProbeVerdict {
  /** True only when a browser media element can be expected to play the URL. */
  consumable: boolean;
  reason: FormatProbeReason;
  /** HTTP status observed, when a response was received at all. */
  status?: number;
  /**
   * Media type with parameters stripped (`audio/mp4; codecs="mp4a.40.2"`
   * becomes `audio/mp4`). Recorded, never matched against: a fragile
   * exact-string content-type check is what would wrongly reject a valid
   * format, so nothing here gates on it.
   */
  contentType?: string;
  /**
   * Set on a rejected candidate when a bounded range succeeded although the
   * whole-body request did not. Means the URL is alive and the refusal is the
   * documented adaptive-URL whole-body policy, not a broken or expired source.
   */
  boundedRangeOk?: boolean;
}

export interface FormatProbeOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

function classifyStatus(status: number): FormatProbeReason {
  if (status === 403) {
    return "probe_status_403";
  }
  if (status === 404) {
    return "probe_status_404";
  }
  if (status === 416) {
    return "probe_status_416";
  }
  return "probe_status_other";
}

function baseContentType(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const base = value.split(";")[0]?.trim().toLowerCase();
  return base ? base : undefined;
}

function isPlayableStatus(status: number): boolean {
  // A CDN may answer a whole-body media read with either 200 (no range
  // semantics) or 206 (range semantics honoured). Both are playable, and
  // requiring one specific code would be a false negative on the other.
  return status === 200 || status === 206;
}

type ProbeOutcome =
  | { kind: "response"; status: number; contentType: string | null }
  | { kind: "failure"; reason: "probe_timeout" | "probe_network_error" };

async function sendProbe(
  fetchFn: typeof fetch,
  url: string,
  range: string,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => {
    timedOut = true;
  };
  controller.signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      headers: { Range: range },
      redirect: "manual",
      signal: controller.signal,
    });
    try {
      await response.body?.cancel();
    } catch {
      // Status is all we need; body teardown failures are irrelevant.
    }
    return {
      kind: "response",
      status: response.status,
      contentType: response.headers?.get?.("content-type") ?? null,
    };
  } catch (error) {
    const aborted = timedOut || (error as { name?: string } | null)?.name === "AbortError";
    return { kind: "failure", reason: aborted ? "probe_timeout" : "probe_network_error" };
  } finally {
    controller.signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  }
}

/**
 * Probes one candidate URL the way a browser media element would and reports
 * a consumable/not verdict with a stable reason. Never throws: a broken probe
 * is not evidence about the format, so it yields `probe_network_error` and the
 * caller moves on to the next candidate.
 */
export async function probeFormatConsumability(
  url: string,
  options: FormatProbeOptions = {},
): Promise<FormatProbeVerdict> {
  if (typeof url !== "string" || url.length === 0) {
    return { consumable: false, reason: "missing_url" };
  }
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? FORMAT_VALIDATE_TIMEOUT_MS;

  const whole = await sendProbe(fetchFn, url, WHOLE_BODY_RANGE, timeoutMs);
  if (whole.kind === "failure") {
    return { consumable: false, reason: whole.reason };
  }

  if (isPlayableStatus(whole.status)) {
    return {
      consumable: true,
      reason: "consumable",
      status: whole.status,
      contentType: baseContentType(whole.contentType),
    };
  }

  const verdict: FormatProbeVerdict = {
    consumable: false,
    reason: classifyStatus(whole.status),
    status: whole.status,
    contentType: baseContentType(whole.contentType),
  };

  // 403 and 416 are the statuses where "URL is dead" and "CDN refuses
  // whole-body reads of this adaptive URL" are indistinguishable from the
  // response alone. One bounded read separates them for the log. 404 is not
  // ambiguous and 5xx is a provider fault, so neither pays for the extra hop.
  if (whole.status === 403 || whole.status === 416) {
    const bounded = await sendProbe(fetchFn, url, BOUNDED_CONFIRM_RANGE, timeoutMs);
    if (bounded.kind === "response" && isPlayableStatus(bounded.status)) {
      verdict.boundedRangeOk = true;
    }
  }

  return verdict;
}

/**
 * Boolean form of {@link probeFormatConsumability}. Returns true when the URL
 * answers a whole-body range request with playable media (HTTP 200/206). Any
 * other status, timeout, or network failure returns false — the candidate is
 * skipped, never fatal.
 */
export async function isFormatConsumable(
  url: string,
  options: FormatProbeOptions = {},
): Promise<boolean> {
  const verdict = await probeFormatConsumability(url, options);
  return verdict.consumable;
}
