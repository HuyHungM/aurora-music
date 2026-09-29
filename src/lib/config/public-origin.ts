/**
 * The deployment's public origin, and the origin Auth.js is told to use.
 *
 * WHY THIS EXISTS. Auth.js derives every absolute URL it emits from exactly
 * one input: the origin of the `Request` handed to it. In a Next.js App Router
 * route that origin is whatever the inbound `Host` / `X-Forwarded-Host` header
 * said, re-applied by `toBrowserOrigin()` in the auth route. Two things then go
 * wrong, and only the second is the proxy's fault.
 *
 * 1. The application could not drop a port even when it was told to.
 *    `URL#host` does not clear an existing port, and Next builds `request.url`
 *    from the port the server was booted with. So `next start -p 24584` plus a
 *    perfectly correct `Host: auroramuzik.dpdns.org` still produced
 *    `https://auroramuzik.dpdns.org:24584/...`. No proxy configuration avoids
 *    that. See the note on `resolveBrowserOrigin`.
 * 2. A reverse proxy that appends the ORIGIN's port to the PUBLIC hostname -
 *    the `httpHostHeader: <public-host>:24584` mistake - supplies a header
 *    that is wrong to begin with, and the application cannot tell a correct
 *    Host header from a wrong one.
 *
 * Either way Google's `redirect_uri` becomes an address that was never
 * registered:
 *
 *   https://auroramuzik.dpdns.org:24584/api/auth/callback/google
 *
 * and every sign-in dies at the callback with `redirect_uri_mismatch`. The
 * origin (`http://127.0.0.1:24584`) is where the process listens; the public
 * origin (`https://auroramuzik.dpdns.org`) is where users and Google live.
 * Conflating the two is the whole bug, so the deployment declares its public
 * origin once and the application stops reading it off the wire.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. No string surgery on the host: not
 * `.replace(":24584", "")`, not a regex that strips any `:\d+`. That keeps
 * working only for the port that happens to be wrong today, and it would
 * happily break a legitimate `http://192.168.1.32:3000` LAN origin. The
 * declared value is parsed as a URL and used as parsed, so what the operator
 * wrote is what the OAuth URL is built from.
 */

/**
 * One message for every rejection, so the boot error names the rule rather
 * than a specific field the operator has to reverse-engineer from a `URL`
 * parse failure.
 */
export const PUBLIC_ORIGIN_ERROR =
  "AURORA_PUBLIC_URL must be an absolute http(s) origin with no path, " +
  "query, fragment or credentials (e.g. https://auroramuzik.dpdns.org)";

/**
 * Validate and normalize a declared public origin, or return `null`.
 *
 * Normalization is `URL#origin`, which is the form every consumer wants and
 * which is idempotent: it lower-cases the scheme and host, drops a default
 * port (`https://host:443` -> `https://host`), keeps a non-default one
 * (`http://host:3100`), and discards a bare trailing slash. A value that
 * cannot be normalized is rejected rather than repaired, because every repair
 * available here is a guess about what the operator meant.
 *
 * A path is refused for a reason that is not tidiness: Auth.js derives
 * `basePath` from `new URL(AUTH_URL).pathname`, so a declared
 * `https://host/aurora` would silently move the callback off
 * `/api/auth/callback/google` and break sign-in with a 404 that names neither
 * the cause nor this file.
 */
export function parsePublicOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.username !== "" || url.password !== "") {
    return null;
  }
  if (url.search !== "" || url.hash !== "") {
    return null;
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    return null;
  }
  // `new URL("https://host")` has an empty pathname; `new URL("https://x/")`
  // has "/". Both are the same origin and both normalize to the same string,
  // which is what makes the two variables comparable in `parseEnv`.
  return url.origin;
}

export interface BrowserOriginInput {
  /** The absolute URL Next.js built for this request. */
  readonly requestUrl: string;
  /** The inbound request headers, read for the proxy's opinion. */
  readonly headers: Headers;
  /**
   * `AURORA_PUBLIC_URL`, already validated and normalized. When present it is
   * authoritative for BOTH host and scheme, and the headers are not consulted
   * at all.
   */
  readonly configuredOrigin?: string | undefined;
}

/** A host, split into the two parts that have to be set independently. */
interface SplitHost {
  readonly hostname: string;
  readonly port: string;
}

/**
 * A `Host` header is a host and an optional port and nothing else.
 *
 * Allowed charset first, because `new URL("http://a b")` throws while
 * `new URL("http://a%20b")` happily produces a nonsense host, and this function
 * feeds its result straight into a URL the browser will be redirected to. The
 * structural checks then reject what the charset permits but a Host header does
 * not mean - a path, userinfo, a query - so a malformed header is refused
 * rather than half-applied.
 */
const HOST_SHAPE = /^[A-Za-z0-9.:[\]-]+$/;

function splitHost(value: string): SplitHost | null {
  const candidate = value.trim();
  if (candidate === "" || !HOST_SHAPE.test(candidate)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${candidate}`);
  } catch {
    return null;
  }
  if (
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return null;
  }
  return { hostname: parsed.hostname, port: parsed.port };
}

/**
 * The origin the request should be re-issued on, or `null` to pass it through
 * untouched.
 *
 * `null` is a real answer and not a failure: it means the request is already
 * anchored to the right origin, so the caller can forward the original
 * `NextRequest` and skip the rebuild entirely. It is also the answer for a
 * request with no usable `Host` header, and for a malformed one.
 *
 * Precedence, and why it is this way:
 *
 * 1. A declared public origin wins outright. It is the only input the operator
 *    controls, and trusting the header once a declaration exists would mean
 *    the declaration could be silently overridden by the very proxy
 *    misconfiguration it exists to survive. This also tightens security: with
 *    a declaration, a spoofed `Host` header can no longer steer an OAuth
 *    redirect at all, which is the one thing `trustHost: true` always needed a
 *    proxy to guarantee.
 * 2. Otherwise the header is honoured, exactly as before -
 *    `x-forwarded-host` then `host`, because behind a proxy the forwarded
 *    value is the public one. This is what makes LAN sign-in keep working
 *    from a phone opening `http://192.168.1.32:3000`.
 * 3. The scheme is never guessed. Without a declaration it comes from
 *    `x-forwarded-proto` or the request's own scheme, so a plain-HTTP origin
 *    stays plain HTTP and `Secure` cookies keep their meaning. WITH a
 *    declaration the declared scheme wins, because the declared scheme is the
 *    one users and Google actually reach the app on - a tunnel that terminates
 *    TLS in front of a plain-HTTP origin would otherwise mint a `redirect_uri`
 *    the browser cannot follow back.
 *
 * WHY `hostname` AND `port`, NEVER `host`. `URL#host` does not clear an
 * existing port: host parsing starts from the URL's current port, so
 *
 *   new URL("https://localhost:24584/api/auth/providers").host = "auroramuzik.dpdns.org"
 *   // -> https://auroramuzik.dpdns.org:24584/api/auth/providers
 *
 * and because Next builds `request.url` from the port the server was booted
 * with, `next start -p 24584` puts `:24584` into every rewritten origin no
 * matter what the `Host` header says. That is the mechanism behind the
 * production `redirect_uri`, and it is in the application rather than in the
 * proxy: a correctly-configured tunnel would not have avoided it. Setting the
 * two parts separately is the only way to say "this origin has no port", which
 * is what the public origin means.
 */
export function resolveBrowserOrigin(input: BrowserOriginInput): URL | null {
  const current = new URL(input.requestUrl);

  let target: SplitHost;
  let protocol: string;
  const configured = input.configuredOrigin;
  if (configured) {
    const declared = new URL(configured);
    target = { hostname: declared.hostname, port: declared.port };
    protocol = declared.protocol.slice(0, -1);
  } else {
    const forwardedHost =
      input.headers.get("x-forwarded-host") ?? input.headers.get("host");
    if (!forwardedHost) {
      // No host to anchor to: forwarding the request unchanged is the only
      // answer that does not invent one.
      return null;
    }
    const split = splitHost(forwardedHost);
    if (!split) {
      // A malformed `Host` is a proxy bug, not a licence to guess. The old
      // `url.host = value` assignment had the same posture for free - the URL
      // host setter silently ignores a value it cannot parse - so this keeps
      // that property while setting the parts separately.
      return null;
    }
    target = split;
    protocol =
      input.headers
        .get("x-forwarded-proto")
        ?.split(",")[0]
        ?.trim() || current.protocol.replace(/:$/, "");
  }

  if (
    current.hostname === target.hostname &&
    current.port === target.port &&
    current.protocol === `${protocol}:`
  ) {
    return null;
  }
  const url = new URL(current);
  url.protocol = `${protocol}:`;
  url.hostname = target.hostname;
  // `""` is how a port is removed; assigning a host alone never does it.
  url.port = target.port;
  return url;
}
