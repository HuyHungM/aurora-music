import { afterEach, describe, expect, it, vi } from "vitest";
import { customFetch } from "@auth/core";

import { buildProviders, googleDiscoveryFetch } from "@/lib/auth/options";
import type { EnvConfig } from "@/lib/config/env";

const GOOGLE_DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";

const noOAuth: EnvConfig = {
  NODE_ENV: "development",
  DATABASE_URL: "file:./dev.db",
  AUTH_GOOGLE_ID: undefined,
  AUTH_GOOGLE_SECRET: undefined,
  AUTH_GITHUB_ID: undefined,
  AUTH_GITHUB_SECRET: undefined,
};

function stubFetch(response: Response) {
  const impl = vi.fn(async () => response);
  vi.stubGlobal("fetch", impl);
  return impl;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("googleDiscoveryFetch", () => {
  it("drops the RFC 9207 iss-support flag from Google's discovery metadata", async () => {
    const metadata = {
      issuer: "https://accounts.google.com",
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
      authorization_response_iss_parameter_supported: true,
    };
    stubFetch(
      new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await googleDiscoveryFetch(GOOGLE_DISCOVERY);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("authorization_response_iss_parameter_supported");
    // Everything else must survive untouched.
    expect(body.issuer).toBe("https://accounts.google.com");
    expect(body.jwks_uri).toBe("https://www.googleapis.com/oauth2/v3/certs");
    expect(body.token_endpoint).toBe("https://oauth2.googleapis.com/token");
  });

  it("accepts a URL object as input", async () => {
    stubFetch(
      new Response(JSON.stringify({ authorization_response_iss_parameter_supported: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await googleDiscoveryFetch(new URL(GOOGLE_DISCOVERY));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("authorization_response_iss_parameter_supported");
  });

  it("forwards non-discovery requests untouched", async () => {
    const original = new Response("access_token=1", { status: 200 });
    stubFetch(original);

    const response = await googleDiscoveryFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
    });
    expect(response).toBe(original);
  });

  it("forwards a failed discovery response untouched", async () => {
    const original = new Response("upstream error", { status: 503 });
    stubFetch(original);

    const response = await googleDiscoveryFetch(GOOGLE_DISCOVERY);
    expect(response).toBe(original);
  });

  it("forwards a non-JSON discovery body untouched", async () => {
    const original = new Response("<html>not json</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
    stubFetch(original);

    const response = await googleDiscoveryFetch(GOOGLE_DISCOVERY);
    expect(response).toBe(original);
  });

  it("forwards metadata untouched when the flag is already absent", async () => {
    const original = new Response(JSON.stringify({ issuer: "https://accounts.google.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    stubFetch(original);

    const response = await googleDiscoveryFetch(GOOGLE_DISCOVERY);
    expect(response).toBe(original);
  });

  it("is wired into the Google provider only", () => {
    const providers = buildProviders({
      ...noOAuth,
      AUTH_GOOGLE_ID: "g-id",
      AUTH_GOOGLE_SECRET: "g-secret",
      AUTH_GITHUB_ID: "h-id",
      AUTH_GITHUB_SECRET: "h-secret",
    });

    // Auth.js providers keep the user config under `options` until
    // `parseProviders` lifts `customFetch` onto the normalized provider.
    type WithOptions = { options: Record<symbol, unknown> };
    const find = (id: string) =>
      providers.find((p) => (p as { id?: string }).id === id) as unknown as WithOptions;

    expect(find("google").options[customFetch]).toBe(googleDiscoveryFetch);
    expect(find("github").options[customFetch]).toBeUndefined();
  });
});
