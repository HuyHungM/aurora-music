/**
 * TEMPORARY dual-egress failover for YouTube playback resolution.
 * SERVER-ONLY.
 *
 * Primary is always tried first; secondary is used only when primary returns
 * one of the retryable InnerTube failure classes below. This is failover, not
 * rotation: the order is deterministic and each egress is attempted at most
 * once per video. googlevideo handling is untouched — candidates are still
 * validated directly and the browser still receives a direct signed URL.
 *
 * Only InnerTube metadata requests go through the configured proxies. Proxy
 * URLs may embed credentials; they are read from validated environment
 * configuration and only the labels `primary`/`secondary` ever reach logs.
 */

import { ExtractorError } from "@/lib/domain";
import { getEnv } from "@/lib/config/env";
import { logger } from "@/lib/diagnostics/logger";
import { failoverProxySession } from "../innertube/failover-session";
import type { YouTubeEgressLabel } from "../innertube/failover-session";
import { createInnertubePlaybackClient } from "./innertube-client";
import type {
  PlaybackMediaInfo,
  YouTubePlaybackClient,
} from "./types";

export type EgressFailureCategory =
  | "none"
  | "timeout"
  | "connection"
  | "login_required"
  | "unusable_playability"
  | "zero_candidates"
  | "missing_streaming_data"
  | "upstream_retryable"
  | "circuit_open"
  | "unknown";

export interface FailoverProxyConfig {
  primaryUrl: string;
  secondaryUrl: string | null;
}

/** Consecutive failed attempts before an egress is rested. */
export const EGRESS_FAILURE_THRESHOLD = 3;
/** How long a repeatedly failing egress is skipped. */
export const EGRESS_COOLDOWN_MS = 5 * 60_000;

export interface EgressBreakerState {
  consecutiveFailures: number;
  cooldownUntil: number;
}

export interface FailoverBreakerState {
  primary: EgressBreakerState;
  secondary: EgressBreakerState;
}

export interface FailoverEgressClients {
  primary: YouTubePlaybackClient;
  secondary?: YouTubePlaybackClient | null;
}

export interface FailoverEgressOptions {
  clients: FailoverEgressClients;
  /** Injectable clock for deterministic circuit-breaker tests. */
  now?: () => number;
  /** Injectable breaker state; production uses the shared process state. */
  breaker?: FailoverBreakerState;
}

export function createFailoverBreakerState(): FailoverBreakerState {
  return {
    primary: { consecutiveFailures: 0, cooldownUntil: 0 },
    secondary: { consecutiveFailures: 0, cooldownUntil: 0 },
  };
}

let sharedBreakerState = createFailoverBreakerState();

/** Test hook: forgets shared circuit-breaker counters. Never used in production. */
export function resetYouTubeEgressFailover(): void {
  sharedBreakerState = createFailoverBreakerState();
}

/**
 * Reads the temporary failover configuration. The legacy single-proxy
 * variable stays the primary fallback so adding only a secondary does not
 * disturb the egress that is already verified in production.
 */
export function readFailoverProxyConfig(
  env = getEnv(),
): FailoverProxyConfig | null {
  const primaryUrl =
    env.AURORA_YOUTUBE_EGRESS_PROXY_PRIMARY?.trim() ||
    env.AURORA_YOUTUBE_EGRESS_PROXY?.trim() ||
    "";
  if (primaryUrl === "") {
    return null;
  }
  const secondaryUrl = env.AURORA_YOUTUBE_EGRESS_PROXY_SECONDARY?.trim() || "";
  return { primaryUrl, secondaryUrl: secondaryUrl === "" ? null : secondaryUrl };
}

/**
 * Classifies an InnerTube failure without preserving any provider text.
 * Only the fixed category leaves this function; messages, URLs, headers, and
 * credentials stay with the discarded error.
 */
function failureText(error: unknown, seen = new Set<unknown>(), depth = 0): string {
  if (depth > 3 || (typeof error === "object" && error !== null && seen.has(error))) {
    return "";
  }
  if (typeof error === "object" && error !== null) {
    seen.add(error);
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  const cause = (error as { cause?: unknown } | null)?.cause;
  const causeText = cause === undefined ? "" : failureText(cause, seen, depth + 1);
  return causeText === "" ? message : `${message}\n${causeText}`;
}

export function classifyEgressFailure(error: unknown): EgressFailureCategory {
  const message = failureText(error);
  if (/login[_\s-]?required/i.test(message)) {
    return "login_required";
  }
  if (
    (error instanceof Error &&
      (error.name === "TimeoutError" ||
        (error as { code?: unknown }).code === "ETIMEDOUT")) ||
    /timed out|timeout/i.test(message)
  ) {
    return "timeout";
  }
  if (
    /fetch failed|failed to fetch|network|socket hang up|ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|connection (?:reset|refused|aborted|closed)|unable to connect/i.test(
      message,
    )
  ) {
    return "connection";
  }
  if (/unplayable|playability|not playable/i.test(message)) {
    return "unusable_playability";
  }
  if (/missing streaming|streaming[_\s-]?data|invalid streaming/i.test(message)) {
    return "missing_streaming_data";
  }
  if (error instanceof ExtractorError && error.retryable) {
    return "upstream_retryable";
  }
  return "unknown";
}

function isRetryableEgressFailure(
  error: unknown,
  category: EgressFailureCategory,
): boolean {
  if (
    category === "timeout" ||
    category === "connection" ||
    category === "login_required" ||
    category === "unusable_playability" ||
    category === "missing_streaming_data" ||
    category === "upstream_retryable"
  ) {
    return true;
  }
  return error instanceof ExtractorError && error.retryable;
}

/** Counts formats that actually carry a usable media URL. */
function usableCandidateCount(media: PlaybackMediaInfo | null | undefined): number | null {
  if (!media || !Array.isArray(media.formats)) {
    return null;
  }
  let count = 0;
  for (const candidate of media.formats) {
    if (typeof candidate?.url === "string" && candidate.url.length > 0) {
      count += 1;
    }
  }
  return count;
}

function logEgressAttempt(args: {
  label: YouTubeEgressLabel;
  videoId: string;
  success: boolean;
  candidateCount: number;
  failureCategory: EgressFailureCategory;
  latencyMs: number;
}): void {
  const latency = Number.isFinite(args.latencyMs)
    ? Math.max(0, Math.floor(args.latencyMs))
    : 0;
  const message = args.success
    ? "YouTube egress attempt succeeded"
    : "YouTube egress attempt failed";
  const log = args.success ? logger.info : logger.warn;
  log(message, {
    event: "youtube.egress_attempt",
    proxy: args.label,
    videoId: args.videoId,
    success: args.success,
    candidateCount: args.candidateCount,
    failureCategory: args.failureCategory,
    latencyMs: latency,
  });
}

function recordEgressSuccess(state: FailoverBreakerState, label: YouTubeEgressLabel): void {
  state[label] = { consecutiveFailures: 0, cooldownUntil: 0 };
}

function recordEgressFailure(
  state: FailoverBreakerState,
  label: YouTubeEgressLabel,
  nowMs: number,
): void {
  const consecutiveFailures = state[label].consecutiveFailures + 1;
  state[label] = {
    consecutiveFailures,
    cooldownUntil:
      consecutiveFailures >= EGRESS_FAILURE_THRESHOLD
        ? nowMs + EGRESS_COOLDOWN_MS
        : state[label].cooldownUntil,
  };
}

export function createFailoverYouTubePlaybackClient(
  options: FailoverEgressOptions,
): YouTubePlaybackClient {
  const primary = options.clients.primary;
  const secondary = options.clients.secondary ?? null;
  const now = options.now ?? Date.now;
  const breaker = options.breaker ?? sharedBreakerState;

  return {
    async getMediaInfo(videoId: string): Promise<PlaybackMediaInfo> {
      const labels: YouTubeEgressLabel[] = secondary
        ? ["primary", "secondary"]
        : ["primary"];
      let lastMedia: PlaybackMediaInfo | null = null;
      let lastError: unknown = null;

      for (const label of labels) {
        const client = label === "primary" ? primary : secondary;
        if (!client) {
          continue;
        }
        const started = now();
        if (now() < breaker[label].cooldownUntil) {
          // A resting egress is skipped without opening a connection, so a
          // known-bad proxy is not retried endlessly.
          logEgressAttempt({
            label,
            videoId,
            success: false,
            candidateCount: 0,
            failureCategory: "circuit_open",
            latencyMs: 0,
          });
          continue;
        }
        try {
          const media = await client.getMediaInfo(videoId);
          const candidateCount = usableCandidateCount(media);
          if (candidateCount === null) {
            recordEgressFailure(breaker, label, now());
            logEgressAttempt({
              label,
              videoId,
              success: false,
              candidateCount: 0,
              failureCategory: "missing_streaming_data",
              latencyMs: now() - started,
            });
            continue;
          }
          if (candidateCount === 0) {
            // Zero usable candidates is retryable here because a challenged
            // egress answers with a valid player response and no streaming
            // data. The last empty result is retained so permanent policy
            // flags (private/live/upcoming) still reach the resolver.
            recordEgressFailure(breaker, label, now());
            logEgressAttempt({
              label,
              videoId,
              success: false,
              candidateCount,
              failureCategory: "zero_candidates",
              latencyMs: now() - started,
            });
            lastMedia = media;
            continue;
          }
          recordEgressSuccess(breaker, label);
          logEgressAttempt({
            label,
            videoId,
            success: true,
            candidateCount,
            failureCategory: "none",
            latencyMs: now() - started,
          });
          return media;
        } catch (error) {
          const failureCategory = classifyEgressFailure(error);
          logEgressAttempt({
            label,
            videoId,
            success: false,
            candidateCount: 0,
            failureCategory,
            latencyMs: now() - started,
          });
          if (!isRetryableEgressFailure(error, failureCategory)) {
            throw error;
          }
          recordEgressFailure(breaker, label, now());
          lastError = error;
        }
      }

      if (lastMedia) {
        return lastMedia;
      }
      if (lastError) {
        throw lastError;
      }
      throw new ExtractorError(
        "youtube",
        "getMediaInfo",
        "YouTube playback info failed",
        { retryable: true },
      );
    },
  };
}

interface CachedFailoverPlaybackClient {
  primaryUrl: string;
  secondaryUrl: string | null;
  client: YouTubePlaybackClient;
}

let cachedFailoverPlaybackClient: CachedFailoverPlaybackClient | null = null;

/** Test hook: forgets the cached production failover client. */
export function resetFailoverPlaybackClient(): void {
  cachedFailoverPlaybackClient = null;
}

/**
 * Production client selector. Unconfigured deployments keep the existing
 * direct/shared-session client byte-for-byte; a configured primary without a
 * secondary uses that egress without failover; two configured proxies use
 * primary-first failover with a shared in-process circuit breaker.
 */
export function createFailoverAwarePlaybackClient(): YouTubePlaybackClient {
  const config = readFailoverProxyConfig();
  if (!config) {
    return createInnertubePlaybackClient();
  }
  if (!config.secondaryUrl) {
    return createInnertubePlaybackClient({
      sessionFactory: () => failoverProxySession("primary"),
    });
  }
  if (
    cachedFailoverPlaybackClient &&
    cachedFailoverPlaybackClient.primaryUrl === config.primaryUrl &&
    cachedFailoverPlaybackClient.secondaryUrl === config.secondaryUrl
  ) {
    return cachedFailoverPlaybackClient.client;
  }
  const client = createFailoverYouTubePlaybackClient({
    clients: {
      primary: createInnertubePlaybackClient({
        sessionFactory: () => failoverProxySession("primary"),
      }),
      secondary: createInnertubePlaybackClient({
        sessionFactory: () => failoverProxySession("secondary"),
      }),
    },
  });
  cachedFailoverPlaybackClient = {
    primaryUrl: config.primaryUrl,
    secondaryUrl: config.secondaryUrl,
    client,
  };
  return client;
}
