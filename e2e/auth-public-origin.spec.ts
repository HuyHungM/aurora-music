import { test, expect } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

/**
 * The OAuth `redirect_uri` regression, against the real production build.
 *
 * Auth.js derives every absolute URL it emits — `signinUrl`, `callbackUrl`, the
 * OIDC `redirect_uri`, the post-callback redirect, and whether the session
 * cookie is `Secure` — from one value: the origin of the `Request` handed to
 * it. The auth route rebuilds that request on the origin the browser used, so
 * this spec is really about one function, and the unit suite in
 * `src/lib/config/public-origin.test.ts` covers its decision table.
 *
 * What the unit suite cannot see is the half that broke in production: Next
 * builds `request.url` from the port the server was *booted* with, and the
 * previous `url.host = value` assignment does not clear an existing port. So
 * `next start -p 3100` plus a perfectly correct
 * `Host: auroramuzik.dpdns.org` still answered
 * `https://auroramuzik.dpdns.org:3100/api/auth/...` — an address Google has
 * never heard of. That interaction only exists in a real build, which is why it
 * is asserted here.
 *
 * `node:http` rather than Playwright's request fixture, for one reason: `Host`
 * is a forbidden header name for `fetch`, and this spec's entire subject is
 * what the application does with the `Host` it is given. Node's client sets it
 * verbatim.
 *
 * Two things this spec deliberately does NOT assert, because Next.js decides
 * them and the assertions would only pin the framework:
 *  - A `Host` header naming a loopback interface is normalized by Next to its
 *    own `localhost`, so a probe addressed at `127.0.0.1:3100` is answered
 *    with the `localhost` origin. That is correct — a loopback request has no
 *    public origin — so it is asserted as "still loopback" rather than as an
 *    exact string.
 *  - `next start`'s own idea of the local hostname, which is a boot-time
 *    detail. Loopback origins are therefore matched by name, not by string.
 *
 * Fully offline-safe: no Google credentials, no OAuth round trip, no provider
 * call. `/api/auth/providers` and `/api/auth/csrf` are both derived from the
 * same `params.url.origin` the OAuth flow uses — `@auth/core` composes
 * `callbackUrl` from it and nothing else — so they are faithful and far
 * cheaper witnesses than a real sign-in.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
const BOOT_PORT = new URL(baseURL).port || "3000";

/** The public origin the production deployment declares. */
const PUBLIC_ORIGIN = "https://auroramuzik.dpdns.org";

/**
 * A host the tunnel would send if its `httpHostHeader` override appended the
 * origin's port to the public hostname. This is the production failure, and it
 * is the one case the configuration variable - not the code - resolves.
 */
const TAUNTED_HOST = "auroramuzik.dpdns.org:24584";

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** Ask the running server something, with a chosen `Host`. */
function probe(
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  const target = new URL(path, baseURL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error(`probe timed out: ${baseURL}${path}`));
    });
    req.end();
  });
}

async function providerCallbackUrls(
  headers: Record<string, string>,
): Promise<string[]> {
  const response = await probe("/api/auth/providers", headers);
  expect(response.status, response.body.slice(0, 200)).toBe(200);
  const providers = JSON.parse(response.body) as Record<
    string,
    { callbackUrl: string; signinUrl: string }
  >;
  const urls = Object.values(providers).map((provider) => provider.callbackUrl);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) {
    expect(url).toContain("/api/auth/callback/");
  }
  return urls;
}

function setCookies(headers: Response["headers"]): string[] {
  const value = headers["set-cookie"];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/** A loopback origin, whatever the framework decided to call it. */
function expectLoopbackOrigin(url: string): void {
  const { hostname, port, protocol } = new URL(url);
  expect(["localhost", "127.0.0.1", "[::1]", "::1"]).toContain(hostname);
  expect(protocol).toBe("http:");
  expect(port).toBe(BOOT_PORT);
}

test.describe("Auth.js public origin", () => {
  test("anchors on the request's own loopback origin when nothing is forwarded", async () => {
    // The case that must not regress: a local request gets a local answer, and
    // `/api/auth/*` keeps working without any configuration at all.
    for (const url of await providerCallbackUrls({})) {
      expectLoopbackOrigin(url);
    }
  });

  test("does not leak the boot port into a public host sent with no port", async () => {
    // THE FIX. A tunnel configured correctly forwards the public hostname with
    // no port, and the answer must be the public origin exactly. Before the
    // fix the port `next start` was booted with came along for the ride,
    // because `URL#host` does not clear an existing port.
    for (const url of await providerCallbackUrls({
      host: "auroramuzik.dpdns.org",
      "x-forwarded-proto": "https",
    })) {
      expect(url.startsWith(`${PUBLIC_ORIGIN}/`)).toBe(true);
      // The authority, with no `:port` in it. Spelled this way because
      // `not.toContain(":")` would of course trip on the scheme.
      expect(url.split("/")[2]).toBe("auroramuzik.dpdns.org");
      expect(new URL(url).port).toBe("");
      expect(url).not.toContain("24584");
      expect(url).not.toContain("zeus.hidencloud.com");
    }
  });

  test("stores the post-login return target without the boot port", async () => {
    // The same origin, seen through Auth.js's own cookie rather than its JSON.
    // `authjs.callback-url` is where the browser is sent after sign-in, so a
    // port in here is a port a real user would be sent to.
    const response = await probe("/api/auth/csrf", {
      host: "auroramuzik.dpdns.org",
      "x-forwarded-proto": "https",
    });
    // The prefix follows the protocol, so it is matched with the prefix
    // optional rather than pinned - pinning it here would assert the cookie
    // rule twice and couple this test to it.
    const callbackCookie = setCookies(response.headers).find((cookie) =>
      /^(?:__Secure-|__Host-)?authjs\.callback-url=/.test(cookie),
    );
    expect(
      callbackCookie,
      setCookies(response.headers).join(" | "),
    ).toBeDefined();
    const stored = decodeURIComponent(
      /authjs\.callback-url=([^;]*)/.exec(callbackCookie as string)?.[1] ?? "",
    );
    expect(stored).toBe(PUBLIC_ORIGIN);
  });

  test("keeps a port the forwarded host does carry", async () => {
    // Not string surgery: a header with a port keeps that port. A rule that
    // stripped `:\d+` would pass the case above and break this one, which is
    // the shape a LAN origin legitimately has.
    for (const url of await providerCallbackUrls({ host: "192.168.1.32:3000" })) {
      expect(url.startsWith("http://192.168.1.32:3000/")).toBe(true);
    }
  });

  test("carries a Host header carrying a foreign port through unchanged", async () => {
    // The residual the configuration variable exists to remove. With no
    // declared origin the header is the origin, by design — so a proxy that
    // sends `<public-host>:24584` still produces the mismatch, and the only fix
    // for that is `AURORA_PUBLIC_URL` in the deployment. Pinned so the residual
    // is visible rather than assumed away.
    for (const url of await providerCallbackUrls({
      host: TAUNTED_HOST,
      "x-forwarded-proto": "https",
    })) {
      expect(url.startsWith(`https://${TAUNTED_HOST}/`)).toBe(true);
    }
  });

  test("refuses a malformed Host header instead of salvaging a prefix of it", async () => {
    // Never a crash and never a 500: an unusable Host falls back to the
    // request's own origin, which is what the previous code did when the
    // header was absent, and what the URL host setter did for a value it could
    // not parse.
    const urls = await providerCallbackUrls({ host: "evil.example/path" });
    for (const url of urls) {
      expect(url).not.toContain("evil.example");
      expectLoopbackOrigin(url);
    }
  });

  test("never guesses a scheme, so a plain-HTTP origin keeps plain cookies", async () => {
    // The security-relevant half of the re-anchoring, and the reason the scheme
    // is read rather than assumed. Auth.js prefixes and flags its cookies from
    // the origin's protocol, so a scheme guessed as `https` would hand a
    // plain-HTTP LAN origin cookies the browser then refuses to send back.
    const plain = await probe("/api/auth/csrf", {});
    const plainNames = setCookies(plain.headers).map((cookie) =>
      cookie.split("=", 1)[0],
    );
    expect(plainNames).toContain("authjs.csrf-token");
    for (const cookie of setCookies(plain.headers)) {
      expect(cookie).not.toContain("Secure");
    }

    const forwarded = await probe("/api/auth/csrf", {
      "x-forwarded-proto": "https",
    });
    const forwardedNames = setCookies(forwarded.headers).map((cookie) =>
      cookie.split("=", 1)[0],
    );
    expect(forwardedNames).toContain("__Host-authjs.csrf-token");
    for (const cookie of setCookies(forwarded.headers)) {
      expect(cookie).toContain("Secure");
    }
  });
});
