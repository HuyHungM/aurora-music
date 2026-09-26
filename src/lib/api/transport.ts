/**
 * Server transport helpers (Phase 52, RULE 33 / RULE 34).
 *
 * This is the ONE place that turns a value into an HTTP response, so it is also
 * the one place that attaches a correlation id. Doing it here rather than at
 * each call site means a route cannot forget: a handler that returns a bare
 * `NextResponse.json(...)` is the exception a reviewer has to notice, not the
 * default.
 *
 * Scope note. The `{data, meta}` / `{error, meta}` envelope from
 * `@/lib/api/error-codes` is deliberately NOT applied to every route here. Two
 * of the three routes are public, cacheable, and already have a published
 * response shape that a load balancer or a wrapper depends on
 * (`/api/health` is asserted key-for-key by its tests; `/api/app-config` is
 * documented as `AppConfigBody`). Re-shaping a shipped public contract to
 * satisfy a new house style would be a breaking change with no client to
 * benefit from it, so the envelope is applied to the ERROR paths of server
 * actions - where the client actually has to branch on the outcome - and the
 * correlation id is applied to every response. See ARCHITECTURE.md,
 * "Client-facing API contract".
 */

import { NextResponse } from "next/server";

import { REQUEST_ID_RESPONSE_HEADER, requestIdFromHeaders } from "./request-id";

/**
 * A JSON response carrying a correlation id in `x-aurora-request-id`.
 *
 * The id is echoed, never trusted: it grants nothing and is derived from
 * nothing secret (see `@/lib/api/request-id`). Accepting `request` as
 * `undefined` keeps this callable from a test or a non-HTTP entry point - a
 * fresh id is minted rather than throwing.
 */
export function jsonResponse<T>(
  body: T,
  options: { request?: Request | null; status?: number; headers?: HeadersInit } = {},
): NextResponse<T> {
  const requestId = requestIdFromHeaders(options.request?.headers ?? null);
  const response = NextResponse.json(body, {
    status: options.status ?? 200,
    headers: options.headers,
  });
  response.headers.set(REQUEST_ID_RESPONSE_HEADER, requestId);
  return response;
}
