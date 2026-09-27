import { NextRequest } from "next/server";

import {
  REQUEST_ID_RESPONSE_HEADER,
  requestIdFromHeaders,
} from "@/lib/api/request-id";
import { handlers } from "@/lib/auth";
import { getEnv } from "@/lib/config/env";
import { resolveBrowserOrigin } from "@/lib/config/public-origin";

/**
 * Re-issue the request on the origin the browser actually used.
 *
 * Auth.js derives EVERY absolute URL it emits from `request.url`: the OAuth
 * `redirect_uri`, the `action` of the sign-in forms it renders, the default
 * `callbackUrl`, the base it validates post-sign-in redirects against, and the
 * protocol that decides whether its session cookies are `Secure`. Next.js
 * derives `request.url` from the hostname and port the server was booted with,
 * NOT from the `Host` header - so from `http://<lan-ip>:3000` Auth.js believes
 * it is `http://localhost:3000` and hands the browser links to a host that does
 * not exist on the phone asking for them. The app's own UI never reads those
 * URLs (it posts to same-origin relative paths), but Auth.js's built-in
 * `/api/auth/signin` page does, and so does every post-authentication
 * redirect.
 *
 * There are two sources for that origin, and the order matters:
 *
 * - `AURORA_PUBLIC_URL`, when the deployment declares one. It is authoritative
 *   for host AND scheme, and the request headers are not consulted at all. A
 *   reverse proxy that appends the internal origin's port to the public
 *   hostname would otherwise rewrite the OAuth `redirect_uri` to an address
 *   Google has never heard of and every sign-in would fail with
 *   `redirect_uri_mismatch` - the application cannot detect that from the
 *   header alone, because the header is exactly what is wrong.
 * - Otherwise `x-forwarded-host` / `host`, which is what `trustHost: true` in
 *   `createAuthOptions` is the documented promise for, and what keeps LAN and
 *   localhost sign-in working. The scheme is then read from
 *   `x-forwarded-proto` or the request's own scheme and never guessed, so a
 *   plain-HTTP LAN origin stays plain HTTP and `Secure` cookies keep their
 *   meaning.
 *
 * `resolveBrowserOrigin()` owns that decision and its reasoning; this function
 * is only the adapter that rebuilds a `NextRequest` from its answer. When the
 * origins already agree it is forwarded untouched, which is every localhost
 * request and every production request whose header is already correct.
 */
function toBrowserOrigin(request: NextRequest): NextRequest {
  const target = resolveBrowserOrigin({
    requestUrl: request.url,
    headers: request.headers,
    configuredOrigin: getEnv().AURORA_PUBLIC_URL,
  });
  if (!target) {
    return request;
  }
  // `NextRequest` re-applies method, headers and body (and the `duplex` flag a
  // streamed body needs), so a sign-in POST body survives the rewrite.
  return new NextRequest(target, request);
}

/**
 * One place for the two things this route does to Auth.js's own response.
 *
 * Auth.js constructs its answers itself - HTML pages, 302 redirects, JSON
 * provider metadata - so they cannot go through `jsonResponse`. Rule 34 still
 * applies to them: every API response carries `x-aurora-request-id`, so a
 * failed sign-in can be correlated with the server log the same way a failed
 * API call can. The id is echoed from the inbound request through the one
 * helper that mints one, and it grants nothing.
 *
 * If a response arrives with immutable headers it simply keeps no id - a
 * correlation label is never worth failing a sign-in over.
 */
async function serve(
  request: NextRequest,
  handler: (request: NextRequest) => Promise<Response>,
): Promise<Response> {
  const response = await handler(toBrowserOrigin(request));
  try {
    response.headers.set(
      REQUEST_ID_RESPONSE_HEADER,
      requestIdFromHeaders(request.headers),
    );
  } catch {
    // see doc comment above
  }
  return response;
}

export async function GET(request: NextRequest): Promise<Response> {
  return await serve(request, handlers.GET);
}

export async function POST(request: NextRequest): Promise<Response> {
  return await serve(request, handlers.POST);
}
