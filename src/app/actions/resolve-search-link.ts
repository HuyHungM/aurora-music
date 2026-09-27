"use server";

import type { DetectedSource } from "@/lib/providers/source-detection";
import type {
  SearchLinkErrorCode,
  SearchLinkResult,
} from "@/lib/search/resolve-link";
import { SearchLinkError, resolveSearchLink } from "@/lib/search/resolve-link";
import {
  canonicalSourceUrl,
  classifySearchInput,
} from "@/lib/search/input";
import { guardServerAction, type GuardFailure } from "@/lib/api/action-guard";

export interface ResolveSearchLinkPayload {
  /** What was recognised, exactly as the detector produced it. */
  source: DetectedSource;
  /** Stable normalized URL; tracking parameters are not identity. */
  canonicalUrl: string;
  resource: SearchLinkResult;
}

/**
 * `unsupported-input` is this action's own rejection — a caller that sent
 * something which is not a recognised provider link. It is kept separate from
 * `unsupported` (a recognised link whose resource the provider cannot serve)
 * so the page never has to guess which of the two it is looking at.
 */
export type ResolveSearchLinkErrorCode = SearchLinkErrorCode | "unsupported-input";

export type ResolveSearchLinkActionResult =
  | { ok: true; result: ResolveSearchLinkPayload }
  | ({
      ok: false;
      error: string;
      linkError?: ResolveSearchLinkErrorCode;
    } & Partial<GuardFailure>);

/**
 * Link resolution is the search surface spending search quota: one paste is
 * one provider lookup plus, for a cross-source catalogue resource, one bounded
 * run of matching searches. It therefore charges the same `search` bucket as
 * `searchUnifiedTracksAction` rather than opening a second, unguarded route to
 * the providers (RULE 12).
 */
const LINK_OFF_MESSAGE = "Search is temporarily unavailable right now.";

/**
 * Resolves a pasted Spotify / YouTube / Deezer link to a canonical resource.
 *
 * Deliberately re-classifies its input: an action is a boundary, and the
 * classification the page performed before calling is not evidence about what
 * a caller might send. Nothing outside the allowlisted hosts and resource ids
 * the detector accepts can reach a provider through here, and no provider
 * request is made for an input this rejects.
 */
export async function resolveSearchLinkAction(
  rawInput: unknown,
): Promise<ResolveSearchLinkActionResult> {
  const denied = await guardServerAction({
    featureOffMessage: LINK_OFF_MESSAGE,
    bucket: "search",
  });
  if (denied) {
    return denied;
  }

  if (typeof rawInput !== "string" || rawInput.trim().length === 0) {
    return {
      ok: false,
      error: "Type a track, artist, or album name to search.",
      linkError: "unsupported-input",
    };
  }

  const classified = classifySearchInput(rawInput);
  if (classified.kind !== "source") {
    return {
      ok: false,
      error: "This link is not supported.",
      linkError: "unsupported-input",
    };
  }

  try {
    const resource = await resolveSearchLink(classified.source);
    return {
      ok: true,
      result: {
        source: classified.source,
        canonicalUrl: canonicalSourceUrl(classified.source),
        resource,
      },
    };
  } catch (error) {
    // Only a code crosses back. Provider messages can name an endpoint, a
    // host or a status and are never handed to the page.
    const linkError: ResolveSearchLinkErrorCode =
      error instanceof SearchLinkError ? error.code : "unavailable";
    return { ok: false, error: "Could not resolve this link.", linkError };
  }
}
