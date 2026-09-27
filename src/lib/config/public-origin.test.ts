import { describe, expect, it } from "vitest";
import {
  parsePublicOrigin,
  resolveBrowserOrigin,
  PUBLIC_ORIGIN_ERROR,
} from "@/lib/config/public-origin";

/**
 * The production incident this module exists for, in the shape it was
 * measured: a Cloudflare Tunnel whose `originRequest.httpHostHeader` override
 * appended the origin's port to the public hostname, so the origin's own
 * process port reached Google's `redirect_uri`.
 */
const PUBLIC_ORIGIN = "https://auroramuzik.dpdns.org";
const TAUNTED_HOST = "auroramuzik.dpdns.org:24584";
const INTERNAL_ORIGIN = "http://127.0.0.1:24584";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

/**
 * The URL Auth.js hands to Google. The base path is not a constant anywhere in
 * the application - it is the route's own file path,
 * `src/app/api/auth/[...nextauth]` - and `@auth/core` composes
 * `${basePath}/callback/${providerId}` from it. Composed the same way here so
 * the assertion is about the origin, and so nothing in the application starts
 * declaring a base path that could drift away from the route.
 */
function callbackUrl(
  requestUrl: string,
  requestHeaders: Headers,
  configuredOrigin?: string,
  providerId = "google",
): string {
  const target = resolveBrowserOrigin({
    requestUrl,
    headers: requestHeaders,
    configuredOrigin,
  });
  return new URL(`/api/auth/callback/${providerId}`, target ?? new URL(requestUrl))
    .toString();
}

describe("parsePublicOrigin", () => {
  it("accepts a bare public origin", () => {
    expect(parsePublicOrigin(PUBLIC_ORIGIN)).toBe(PUBLIC_ORIGIN);
  });

  it("normalizes a trailing slash away", () => {
    // Idempotence is load-bearing: `parseEnv` compares a declared
    // `AURORA_PUBLIC_URL` against an operator's `AUTH_URL`, and the two
    // spellings of the same origin must not read as a disagreement.
    expect(parsePublicOrigin(`${PUBLIC_ORIGIN}/`)).toBe(PUBLIC_ORIGIN);
  });

  it("normalizes surrounding whitespace away", () => {
    expect(parsePublicOrigin(`  ${PUBLIC_ORIGIN}\n`)).toBe(PUBLIC_ORIGIN);
  });

  it("lowercases the scheme and host", () => {
    expect(parsePublicOrigin("HTTPS://AuroraMuzik.DPDNS.org")).toBe(
      PUBLIC_ORIGIN,
    );
  });

  it("drops a default port and keeps a non-default one", () => {
    expect(parsePublicOrigin("https://auroramuzik.dpdns.org:443")).toBe(
      PUBLIC_ORIGIN,
    );
    // A staging origin on a non-default port is legitimate, and stripping
    // ports is exactly the string surgery this module refuses to do.
    expect(parsePublicOrigin("http://127.0.0.1:3100")).toBe(
      "http://127.0.0.1:3100",
    );
  });

  it("keeps a plain-HTTP origin plain", () => {
    expect(parsePublicOrigin("http://aurora.internal")).toBe(
      "http://aurora.internal",
    );
  });

  it("keeps an IPv6 origin intact", () => {
    expect(parsePublicOrigin("http://[::1]:3100")).toBe("http://[::1]:3100");
  });

  it("rejects a value that is not a URL", () => {
    for (const value of ["", "   ", "auroramuzik.dpdns.org", "//host", "/"]) {
      expect(parsePublicOrigin(value), value).toBeNull();
    }
  });

  it("rejects a non-http scheme", () => {
    expect(parsePublicOrigin("ftp://auroramuzik.dpdns.org")).toBeNull();
    expect(parsePublicOrigin("javascript:alert(1)")).toBeNull();
  });

  it("rejects a path, because Auth.js would move basePath with it", () => {
    // `setEnvDefaults()` does `config.basePath = new URL(AUTH_URL).pathname`,
    // so a declared path silently relocates the callback route and sign-in
    // fails with a 404 that names neither the cause nor this rule.
    expect(parsePublicOrigin(`${PUBLIC_ORIGIN}/aurora`)).toBeNull();
  });

  it("rejects a query, a fragment and embedded credentials", () => {
    expect(parsePublicOrigin(`${PUBLIC_ORIGIN}?next=/admin`)).toBeNull();
    expect(parsePublicOrigin(`${PUBLIC_ORIGIN}#x`)).toBeNull();
    expect(parsePublicOrigin("https://user:pass@auroramuzik.dpdns.org")).toBeNull();
  });

  it("publishes one message for every rejection", () => {
    expect(PUBLIC_ORIGIN_ERROR).toContain("AURORA_PUBLIC_URL");
    expect(PUBLIC_ORIGIN_ERROR).toContain("https://auroramuzik.dpdns.org");
  });
});

describe("resolveBrowserOrigin", () => {
  it("leaves the request alone when there is no host to anchor to", () => {
    // Nothing to read, so nothing to claim. Forwarding unchanged is the only
    // answer that does not invent an origin.
    expect(
      resolveBrowserOrigin({
        requestUrl: `${INTERNAL_ORIGIN}/api/auth/signin/google`,
        headers: headers({}),
      }),
    ).toBeNull();
  });

  it("leaves a request already on the right origin untouched", () => {
    expect(
      resolveBrowserOrigin({
        requestUrl: `${INTERNAL_ORIGIN}/api/auth/providers`,
        headers: headers({ host: "127.0.0.1:24584" }),
      }),
    ).toBeNull();
  });

  it("re-anchors Next's boot-time origin onto the browser's host", () => {
    // The LAN case `toBrowserOrigin()` was written for: Next pins
    // `request.url` to the boot hostname, so a phone opening
    // `http://192.168.1.32:3000` would otherwise be handed localhost links.
    const target = resolveBrowserOrigin({
      requestUrl: "http://localhost:3000/api/auth/signin/google",
      headers: headers({ host: "192.168.1.32:3000" }),
    });
    expect(target?.toString()).toBe(
      "http://192.168.1.32:3000/api/auth/signin/google",
    );
  });

  it("drops the boot port when the header's host has none", () => {
    // The other half of the production failure, and the half no proxy
    // configuration can fix. `URL#host` starts host parsing from the URL's
    // CURRENT port, so the previous `url.host = value` assignment carried
    // `next start -p 24584` straight into the public origin even from a
    // correct `Host` header. This asserts the port is genuinely removed, not
    // merely replaced by the same value.
    const target = resolveBrowserOrigin({
      requestUrl: `${INTERNAL_ORIGIN}/api/auth/signin/google`,
      headers: headers({
        host: "auroramuzik.dpdns.org",
        "x-forwarded-proto": "https",
      }),
    });
    expect(target?.toString()).toBe(
      `${PUBLIC_ORIGIN}/api/auth/signin/google`,
    );
    expect(target?.port).toBe("");
  });

  it("keeps a port the header does carry", () => {
    const target = resolveBrowserOrigin({
      requestUrl: `${INTERNAL_ORIGIN}/api/auth/providers`,
      headers: headers({
        host: "auroramuzik.dpdns.org:8443",
        "x-forwarded-proto": "https",
      }),
    });
    expect(target?.toString()).toBe(
      "https://auroramuzik.dpdns.org:8443/api/auth/providers",
    );
  });

  it("handles an IPv6 host with a port", () => {
    const target = resolveBrowserOrigin({
      requestUrl: "http://localhost:3000/api/auth/providers",
      headers: headers({ host: "[::1]:3100" }),
    });
    expect(target?.toString()).toBe("http://[::1]:3100/api/auth/providers");
  });

  it("refuses a malformed Host header instead of salvaging a prefix of it", () => {
    // `new URL("http://user@evil.com")` and `new URL("http://evil.com/path")`
    // both parse into a perfectly usable host, so parsing alone is not a
    // filter. The previous `url.host = value` assignment had the same posture
    // for free, because the URL host setter ignores a value it cannot parse;
    // setting hostname and port separately has to earn it back explicitly.
    for (const host of [
      "evil.com/path",
      "user@evil.com",
      "user:pass@evil.com",
      "evil.com?next=/admin",
      "evil.com#x",
      "host:not-a-port",
      "a b",
      "  ",
    ]) {
      expect(
        resolveBrowserOrigin({
          requestUrl: `${INTERNAL_ORIGIN}/api/auth/providers`,
          headers: headers({ host }),
        }),
        host,
      ).toBeNull();
    }
  });

  it("prefers x-forwarded-host over host", () => {
    const target = resolveBrowserOrigin({
      requestUrl: `${INTERNAL_ORIGIN}/api/auth/providers`,
      headers: headers({
        host: "127.0.0.1:24584",
        "x-forwarded-host": "auroramuzik.dpdns.org",
        "x-forwarded-proto": "https",
      }),
    });
    expect(target?.origin).toBe(PUBLIC_ORIGIN);
  });

  it("reads only the first entry of a comma-joined x-forwarded-proto", () => {
    const target = resolveBrowserOrigin({
      requestUrl: `${INTERNAL_ORIGIN}/api/auth/providers`,
      headers: headers({
        host: "auroramuzik.dpdns.org",
        "x-forwarded-proto": "https, http",
      }),
    });
    expect(target?.protocol).toBe("https:");
  });

  it("does not guess a scheme the request never claimed", () => {
    // A plain-HTTP LAN origin must stay plain HTTP, or `Secure` cookies stop
    // meaning anything on it.
    const target = resolveBrowserOrigin({
      requestUrl: "http://localhost:3000/api/auth/providers",
      headers: headers({ host: "192.168.1.32:3000" }),
    });
    expect(target?.protocol).toBe("http:");
  });

  it("preserves path, query and fragment", () => {
    const target = resolveBrowserOrigin({
      requestUrl: `${INTERNAL_ORIGIN}/api/auth/callback/google?code=abc&state=xyz#frag`,
      headers: headers({
        host: "auroramuzik.dpdns.org",
        "x-forwarded-proto": "https",
      }),
    });
    expect(target?.toString()).toBe(
      "https://auroramuzik.dpdns.org/api/auth/callback/google?code=abc&state=xyz#frag",
    );
  });

  describe("with a declared public origin", () => {
    it("overrides a host header carrying the internal origin's port", () => {
      // THE BUG. Without a declaration the header is honoured verbatim, which
      // is what put `:24584` into Google's `redirect_uri` in production.
      const undeclared = resolveBrowserOrigin({
        requestUrl: `${INTERNAL_ORIGIN}/api/auth/signin/google`,
        headers: headers({
          host: TAUNTED_HOST,
          "x-forwarded-proto": "https",
        }),
      });
      expect(undeclared?.toString()).toBe(
        `https://${TAUNTED_HOST}/api/auth/signin/google`,
      );

      const declared = resolveBrowserOrigin({
        requestUrl: `${INTERNAL_ORIGIN}/api/auth/signin/google`,
        headers: headers({
          host: TAUNTED_HOST,
          "x-forwarded-proto": "https",
        }),
        configuredOrigin: PUBLIC_ORIGIN,
      });
      expect(declared?.toString()).toBe(
        `${PUBLIC_ORIGIN}/api/auth/signin/google`,
      );
    });

    it("overrides an x-forwarded-host naming the internal origin", () => {
      const target = resolveBrowserOrigin({
        requestUrl: `${INTERNAL_ORIGIN}/api/auth/signin/google`,
        headers: headers({
          host: TAUNTED_HOST,
          "x-forwarded-host": "zeus.hidencloud.com:24584",
          "x-forwarded-proto": "http",
        }),
        configuredOrigin: PUBLIC_ORIGIN,
      });
      expect(target?.origin).toBe(PUBLIC_ORIGIN);
    });

    it("ignores the headers entirely, including a wrong scheme", () => {
      // The tunnel terminates TLS in front of a plain-HTTP origin, so
      // `x-forwarded-proto` here would be right and the request's own scheme
      // would be wrong. The declared scheme is the one users and Google reach
      // the app on, so it is the one that must win.
      const target = resolveBrowserOrigin({
        requestUrl: `${INTERNAL_ORIGIN}/api/auth/callback/google`,
        headers: headers({ host: TAUNTED_HOST }),
        configuredOrigin: PUBLIC_ORIGIN,
      });
      expect(target?.toString()).toBe(
        `${PUBLIC_ORIGIN}/api/auth/callback/google`,
      );
    });

    it("resolves to nothing when the request already carries it", () => {
      expect(
        resolveBrowserOrigin({
          requestUrl: `${PUBLIC_ORIGIN}/api/auth/providers`,
          headers: headers({ host: TAUNTED_HOST }),
          configuredOrigin: PUBLIC_ORIGIN,
        }),
      ).toBeNull();
    });

    it("makes a spoofed Host header unable to steer an OAuth redirect", () => {
      // The security consequence of declaring the origin: with a declaration
      // in place, `trustHost: true` is backed by configuration instead of by
      // the assumption that the proxy in front is configured correctly.
      const target = resolveBrowserOrigin({
        requestUrl: `${INTERNAL_ORIGIN}/api/auth/signin/google`,
        headers: headers({
          host: "attacker.example",
          "x-forwarded-host": "attacker.example",
        }),
        configuredOrigin: PUBLIC_ORIGIN,
      });
      expect(target?.origin).toBe(PUBLIC_ORIGIN);
    });
  });
});

describe("generated OAuth callback URLs", () => {
  it("derives Google's redirect URI from the declared public origin", () => {
    const callback = callbackUrl(
      `${INTERNAL_ORIGIN}/api/auth/signin/google`,
      headers({ host: TAUNTED_HOST, "x-forwarded-proto": "https" }),
      PUBLIC_ORIGIN,
    );

    expect(callback).toBe(
      "https://auroramuzik.dpdns.org/api/auth/callback/google",
    );
    expect(callback).not.toContain(":24584");
    expect(callback).not.toContain("zeus.hidencloud.com");
    expect(callback.startsWith("https://")).toBe(true);
  });

  it("derives the same URI for every configured provider", () => {
    for (const providerId of ["google", "github"]) {
      expect(
        callbackUrl(
          `${INTERNAL_ORIGIN}/api/auth/signin/${providerId}`,
          headers({ host: TAUNTED_HOST, "x-forwarded-proto": "https" }),
          PUBLIC_ORIGIN,
          providerId,
        ),
      ).toBe(`https://auroramuzik.dpdns.org/api/auth/callback/${providerId}`);
    }
  });

  it("reproduces the production failure when no origin is declared", () => {
    // The characterization the fix exists to remove. Kept as a test so that
    // the undeclared behaviour can never change silently: with no
    // declaration the header is the origin, which is correct for LAN and
    // localhost and wrong for a misconfigured proxy - and the difference
    // between those two is one environment variable.
    const callback = callbackUrl(
      `${INTERNAL_ORIGIN}/api/auth/signin/google`,
      headers({ host: TAUNTED_HOST, "x-forwarded-proto": "https" }),
    );
    expect(callback).toBe(
      "https://auroramuzik.dpdns.org:24584/api/auth/callback/google",
    );
  });

  it("produces the right URI with only the port bug fixed, and no config", () => {
    // What a correctly-configured tunnel alone now buys: the header is
    // honoured, but the boot port is no longer welded to it. Recorded so the
    // value of the configuration is not overstated - the variable removes the
    // dependency on the proxy, it does not create the fix.
    const callback = callbackUrl(
      `${INTERNAL_ORIGIN}/api/auth/signin/google`,
      headers({ host: "auroramuzik.dpdns.org", "x-forwarded-proto": "https" }),
    );
    expect(callback).toBe(
      "https://auroramuzik.dpdns.org/api/auth/callback/google",
    );
  });
});
