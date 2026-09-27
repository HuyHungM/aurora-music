import { NextRequest } from "next/server";

import {
  REQUEST_ID_RESPONSE_HEADER,
  requestIdFromHeaders,
} from "@/lib/api/request-id";
import { handlers } from "@/lib/auth";

/**
 * Re-issue the request on the origin the browser actually used.
 *
 * Auth.js derives EVERY absolute URL it emits from `request.url`: the OAuth
 * `redirect_uri`, the `action` of the sign-in forms it renders, the default
 * `callbackUrl`, the base it validates post-sign-in redirects against, and the
 * protocol that decides whether its session cookies are `Secure`. Next.js
 * derives `request.url` from the hostname the dev server was booted with
 * (`initURL` is built from `opts.hostname || "localhost"`), NOT from the
 * `Host` header - so from `http://<lan-ip>:3000` Auth.js believes it is
 * `http://localhost:3000` and hands the browser links to a host that does not
 * exist on the phone asking for them. The app's own UI never reads those
 * URLs (it posts to same-origin relative paths), but Auth.js's built-in
 * `/api/auth/signin` page does, and so does every post-authentication
 * redirect.
 *
 * `trustHost: true` in `createAuthOptions` is exactly the promise Auth.js
 * asks for before it relies on request headers, so honouring them here is the
 * documented configuration rather than a workaround. Precedence mirrors
 * Auth.js's own `createActionURL`: `x-forwarded-host`/`x-forwarded-proto`
 * (which Next fills in from `Host`) win, because behind a proxy they are the
 * public values. The protocol is deliberately NOT guessed: only an explicit
 * forwarded protocol or the request's own scheme is used, so a plain-HTTP LAN
 * origin stays plain HTTP and `Secure` cookies keep their meaning.
 *
 * When the origins already agree the original request is forwarded untouched,
 * which is every localhost request and every production request behind a proxy
 * that sets `Host` correctly.
 */
function toBrowserOrigin(request: NextRequest): NextRequest {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) {
    return request;
  }
  const current = new URL(request.url);
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const protocol = forwardedProtocol || current.protocol.replace(/:$/, "");
  if (current.host === host && current.protocol === `${protocol}:`) {
    return request;
  }
  const url = new URL(current);
  url.host = host;
  url.protocol = `${protocol}:`;
  // `NextRequest` re-applies method, headers and body (and the `duplex` flag a
  // streamed body needs), so a sign-in POST body survives the rewrite.
  return new NextRequest(url, request);
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
