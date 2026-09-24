/**
 * Server-side format validation for YouTube playback resolution.
 *
 * SERVER-ONLY. Resolution success does not prove the browser can consume
 * the URL: for some videos the provider serves adaptive audio URLs that
 * answer bounded prefix requests (HTTP 206) yet reject the open-ended
 * range request (`Range: bytes=0-`) a browser media element sends first
 * with HTTP 403. Chromium then surfaces MEDIA_ERR_SRC_NOT_SUPPORTED
 * (code 4) even though the resolver handed out a well-formed AudioSource.
 *
 * The probe mirrors that first browser request — open-ended range, status
 * only, body cancelled immediately — and predicts browser playability
 * without downloading media. It never logs or returns the URL.
 */

/** How long one format probe may take before the candidate is skipped. */
export const FORMAT_VALIDATE_TIMEOUT_MS = 5000;

export interface FormatProbeOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Returns true when the URL answers an open-ended range request with
 * playable media (HTTP 200/206). Any other status, timeout, or network
 * failure returns false — the candidate is skipped, never fatal.
 */
export async function isFormatConsumable(
  url: string,
  options: FormatProbeOptions = {},
): Promise<boolean> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? FORMAT_VALIDATE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      headers: { Range: "bytes=0-" },
      redirect: "manual",
      signal: controller.signal,
    });
    try {
      await response.body?.cancel();
    } catch {
      // Status is all we need; body teardown failures are irrelevant.
    }
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
