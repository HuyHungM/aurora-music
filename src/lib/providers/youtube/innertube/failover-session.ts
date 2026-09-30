/**
 * TEMPORARY dual-egress playback sessions. SERVER-ONLY.
 *
 * Discovery keeps using the shared InnerTube session. Playback failover needs
 * one session per configured egress because an InnerTube session's HTTP client
 * is bound to a single proxy dispatcher when the session is created. These
 * sessions are playback-only, anonymous, and carry no login state; only the
 * InnerTube API is proxied, never googlevideo and never user traffic.
 *
 * Proxy URLs may embed credentials. They are read from validated environment
 * configuration, held only in memoised closures, and never logged.
 */

import type { Innertube } from "youtubei.js";
import { getEnv } from "@/lib/config/env";
import { createProxyInnertubeSession } from "./session";
import { proxyFetchFor } from "./egress";

export type YouTubeEgressLabel = "primary" | "secondary";

const proxySessions = new Map<YouTubeEgressLabel, Promise<Innertube>>();

/** Test hook: forgets memoised failover sessions. Never used in production. */
export function resetFailoverProxySessions(): void {
  proxySessions.clear();
}

/**
 * Returns the configured proxy URL for one failover leg, or null when that
 * leg is disabled. The legacy single-proxy variable remains the primary
 * fallback so an operator can add only a secondary without disturbing the
 * currently verified production egress.
 */
export function failoverProxyUrl(label: YouTubeEgressLabel): string | null {
  const env = getEnv();
  const configured =
    label === "primary"
      ? env.AURORA_YOUTUBE_EGRESS_PROXY_PRIMARY || env.AURORA_YOUTUBE_EGRESS_PROXY
      : env.AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY;
  const trimmed = configured?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/**
 * Returns the memoised playback-only session for one failover leg. A failed
 * creation clears the slot so the next caller retries instead of replaying a
 * cached rejection; per-proxy health is tracked separately by the failover
 * client's circuit breaker.
 */
export function failoverProxySession(label: YouTubeEgressLabel): Promise<Innertube> {
  const cached = proxySessions.get(label);
  if (cached) {
    return cached;
  }
  const created = (async () => {
    const proxyUrl = failoverProxyUrl(label);
    if (!proxyUrl) {
      throw new Error(`YouTube ${label} egress proxy is not configured`);
    }
    return createProxyInnertubeSession(await proxyFetchFor(proxyUrl));
  })().catch((error: unknown) => {
    if (proxySessions.get(label) === created) {
      proxySessions.delete(label);
    }
    throw error;
  });
  proxySessions.set(label, created);
  return created;
}
