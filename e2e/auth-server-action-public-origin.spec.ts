import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";

/**
 * The OAuth `redirect_uri` regression, on the path that initiates sign-in.
 *
 * `e2e/auth-public-origin.spec.ts` covers the other path (`/api/auth/*`, the
 * route handler) and the header matrix. This file covers Path B, which is the
 * one a real user actually clicks:
 *
 *   signInWith()            src/app/actions/auth.ts, a server action
 *     -> signIn(provider)   next-auth/lib/actions.js:6
 *     -> createActionURL()  @auth/core/lib/utils/env.js
 *     -> Auth(req)          emits a 302 to Google's authorize endpoint
 *     -> redirect()         Next.js turns that into a browser navigation
 *
 * WHY IT NEEDS A SERVER OF ITS OWN. The claim under test is that the browser is
 * sent to the *declared* public origin, so the declaration has to be in effect.
 * The shared `webServer` in `playwright.config.ts` has no
 * `AURORA_PUBLIC_URL` — it must not, because the rest of the suite asserts that
 * a deployment which declares nothing keeps deriving its origin from the
 * request, and that is a real property worth protecting. A second
 * `webServer` entry or a dedicated project would work, but both are paid for by
 * every run of the whole suite, and a project-level `testMatch` is a blunt
 * instrument. So this spec boots its own server, and tears it down.
 *
 * The env below deliberately restates the four flags from that `webServer`
 * rather than importing them. It is duplication, and it is the accepted cost:
 * the alternative is a second long-lived process for a five-test file. If a flag
 * there changes, this is the second place that needs it.
 *
 * WHAT IS AND IS NOT PROVEN. The assertion is on the URL the browser is sent
 * to. That URL is fixed before Google's response exists, so this test needs no
 * Google credentials, no OAuth round trip, and no network egress — it captures
 * the outgoing request and never waits on the reply. It therefore proves URL
 * *construction* and nothing about whether a human could complete a login;
 * that needs a real account and a registered redirect URI, neither of which is
 * a property of this repository. The `redirect_uri` is asserted by equality,
 * not by substring: `toContain("auroramuzik.dpdns.org")` would pass for
 * `https://auroramuzik.dpdns.org:24584/...`, which is the exact failure this
 * file exists to catch.
 */

/** The public origin the production deployment declares. */
const PUBLIC_ORIGIN = "https://auroramuzik.dpdns.org";

/** What Google is supposed to be told, exactly. */
const EXPECTED_REDIRECT_URI = `${PUBLIC_ORIGIN}/api/auth/callback/google`;

/** Never an OAuth origin, in any of the shapes it has taken. */
const FORBIDDEN = [
  ":24584",
  "zeus.hidencloud.com",
  "127.0.0.1",
  "localhost",
  "[::1]",
] as const;

interface Response {
  readonly status: number;
  readonly body: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve a port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

interface Origin {
  readonly port: number;
  readonly baseURL: string;
  readonly bootPort: string;
  stop(): Promise<void>;
}

let origin: Origin;

async function startServer(): Promise<Origin> {
  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const child = spawn("bun", ["run", "start", "--", "-p", String(port)], {
    env: {
      ...process.env,
      // The variable under test. Everything else here matches
      // `playwright.config.ts`; see the note at the top of this file.
      AURORA_PUBLIC_URL: PUBLIC_ORIGIN,
      AURORA_E2E_LIVE_PLAYBACK: "1",
      AURORA_E2E_AUTH: "1",
      AURORA_E2E_ALLOW_TEST_FLAGS: "1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (log += chunk.toString()));

  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with ${child.exitCode}:\n${log}`);
    }
    try {
      const response = await fetch(`${baseURL}/api/auth/providers`);
      if (response.status > 0) {
        break;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`server did not become ready:\n${log}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    port,
    baseURL,
    bootPort: String(port),
    async stop() {
      // Awaited, deliberately. A fire-and-forget kill loses the race with the
      // Playwright worker exiting, and an orphaned `next start` keeps the build
      // output directory locked - which fails the NEXT `bun run build` with no
      // useful message. Windows runs `next start` as a grandchild of `bun` and
      // shares no kill signal with it, so the tree is killed by PID there.
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
            stdio: "ignore",
          }).on("exit", () => resolve());
        });
      } else {
        child.kill("SIGKILL");
      }
      // The kill is asynchronous at the OS level too; give the listener a
      // moment to release so a following `next build` is not racing it.
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
  };
}

/** GET a path on the declared server, with a chosen `Host`. */
function probe(path: string, headers: Record<string, string>): Promise<Response> {
  const target = new URL(path, origin.baseURL);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => {
      req.destroy(new Error(`probe timed out: ${origin.baseURL}${path}`));
    });
    req.end();
  });
}

/**
 * Click the real sign-in button and return the Google authorization URL the
 * browser was actually sent to.
 *
 * The listener is attached before the click and nothing waits on Google's
 * response, so this returns as soon as the navigation is issued.
 */
async function startGoogleSignIn(page: import("@playwright/test").Page): Promise<URL> {
  const authorizationRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://accounts.google.com/")) {
      authorizationRequests.push(request.url());
    }
  });

  await page.goto(origin.baseURL);
  // The provider is chosen server-side from configured credentials, so the
  // hidden input is the assertion that the Google path was actually wired up.
  // Selecting the form by its input also survives a UI copy change to the
  // button label, which a `getByRole("button", { name: "Sign in" })` would not.
  //
  // Scoped to the banner because the shell renders this control twice over: the
  // header and the sidebar are siblings, both show it to an anonymous visitor,
  // and both post the identical action. The banner is unique, so this asserts
  // one form rather than silently clicking whichever copy came first in the DOM.
  const form = page
    .getByRole("banner")
    .locator('form:has(input[name="provider"][value="google"])');
  await expect(form).toHaveCount(1);
  await form.locator('button[type="submit"]').click();

  await expect
    .poll(() => authorizationRequests.length, {
      message: "browser was never sent to accounts.google.com",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  return new URL(authorizationRequests[0] as string);
}

// Not `mode: "serial"`. `playwright.config.ts` already pins `workers: 1`, so
// the tests are sequenced regardless, and serial mode would only add one thing:
// the first failure skipping the other four. Each assertion here is independent
// evidence about a different property, so a regression is worth reporting in
// full rather than one line at a time.

test.describe("OAuth redirect_uri on the server-action sign-in path", () => {
  test.beforeAll(async () => {
    origin = await startServer();
  });

  test.afterAll(async () => {
    await origin?.stop();
  });

  test("sends the browser to Google with the declared callback, portless", async ({
    page,
  }) => {
    const authorization = await startGoogleSignIn(page);

    // It really is Google's authorize endpoint, not a local stand-in.
    expect(authorization.host).toBe("accounts.google.com");
    expect(authorization.searchParams.get("client_id")).toBeTruthy();

    const redirectUri = authorization.searchParams.get("redirect_uri");
    expect(redirectUri, "no redirect_uri on the Google authorization request")
      .toBe(EXPECTED_REDIRECT_URI);
  });

  test("never carries an internal origin or the boot port into the callback", async ({
    page,
  }) => {
    const redirectUri = (await startGoogleSignIn(page)).searchParams.get(
      "redirect_uri",
    ) as string;

    // Spelled out rather than left to the equality assert above, because these
    // are the shapes the bug actually took and a reviewer should not have to
    // reconstruct them.
    expect(redirectUri.startsWith("https://")).toBe(true);
    expect(new URL(redirectUri).port).toBe("");
    expect(redirectUri.endsWith("/")).toBe(false);
    expect(redirectUri).not.toContain(`:${origin.bootPort}`);
    for (const forbidden of FORBIDDEN) {
      expect(redirectUri, `callback contained ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  test("agrees with the /api/auth/* path for the same deployment", async ({
    page,
  }) => {
    // The two-path asymmetry, asserted directly. Path A and Path B resolve
    // absolute URLs from independent inputs — Path A from the request the route
    // handler rebuilds, Path B from `createActionURL()` reading `AUTH_URL` — so
    // they can disagree, and in production one of them did. A deployment is only
    // correct if the two agree.
    const browserCallback = (await startGoogleSignIn(page)).searchParams.get(
      "redirect_uri",
    ) as string;
    const routeCallback = await routeHandlerCallbackUrl();

    expect(routeCallback).toBe(EXPECTED_REDIRECT_URI);
    expect(browserCallback).toBe(routeCallback);
  });

  test("ignores a hostile Host header once an origin is declared", async ({
    page,
  }) => {
    // The security half, and the reason the declaration outranks the header.
    // With no declaration a `Host` naming a port is honoured, because the
    // application cannot tell a correct one from a wrong one; with a
    // declaration it is not consulted at all, so a spoofed or
    // proxy-mangled header cannot steer an OAuth redirect anywhere.
    const browserCallback = (await startGoogleSignIn(page)).searchParams.get(
      "redirect_uri",
    ) as string;
    expect(browserCallback).toBe(EXPECTED_REDIRECT_URI);

    // A loopback request, which is what the browser above actually is. The
    // declaration has to win over it, or the callback would be the address the
    // test itself is being served from.
    const routeCallback = await routeHandlerCallbackUrl({
      host: `127.0.0.1:${origin.port}`,
      "x-forwarded-host": "auroramuzik.dpdns.org:24584",
      "x-forwarded-proto": "https",
    });
    expect(routeCallback).toBe(EXPECTED_REDIRECT_URI);
  });

  test("a declared origin survives a boot port that differs from it", async ({
    page,
  }) => {
    // The mechanism, stated as its own test. `next start` was booted on a
    // loopback port; Next builds `request.url` from *that* port, and the
    // original `url.host = value` assignment does not clear an existing port,
    // so the boot port rode along into every rewritten origin. Both paths above
    // are downstream of that; this asserts the boot port is simply absent.
    const browserCallback = (await startGoogleSignIn(page)).searchParams.get(
      "redirect_uri",
    ) as string;
    expect(browserCallback).not.toContain(`:${origin.port}`);
    expect(new URL(browserCallback).origin).toBe(PUBLIC_ORIGIN);
  });
});

/** Path A: the callback URL the route handler reports for Google. */
async function routeHandlerCallbackUrl(
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await probe("/api/auth/providers", headers);
  expect(response.status, response.body.slice(0, 200)).toBe(200);
  const providers = JSON.parse(response.body) as Record<
    string,
    { callbackUrl: string }
  >;
  expect(providers.google, "google provider missing").toBeDefined();
  return (providers.google as { callbackUrl: string }).callbackUrl;
}
