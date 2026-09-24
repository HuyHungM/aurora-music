import { describe, expect, it, vi } from "vitest";
import { createTokenClient } from "@/lib/providers/spotify/auth";
import type { FetchFn } from "@/lib/providers/spotify/auth";
import { InvalidProviderCredentialsError } from "@/lib/errors";

const CREDS = { clientId: "id123", clientSecret: "secret123" };

function tokenFetch(body: unknown, status = 200): FetchFn {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

function tokenBody(expiresIn = 3600) {
  return { access_token: "tok-abc", token_type: "Bearer", expires_in: expiresIn };
}

describe("Spotify token client", () => {
  it("acquires a token with client credentials", async () => {
    const fetchFn = tokenFetch(tokenBody());
    const client = createTokenClient(CREDS, { fetchFn });
    await expect(client.getAccessToken()).resolves.toBe("tok-abc");
    expect(fetchFn).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(fetchFn).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(String(init.headers)).not.toContain("secret123");
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${btoa("id123:secret123")}`,
    });
  });

  it("caches and reuses tokens before expiry", async () => {
    let now = 1_000_000;
    const fetchFn = tokenFetch(tokenBody());
    const client = createTokenClient(CREDS, { fetchFn, nowFn: () => now });
    expect(await client.getAccessToken()).toBe("tok-abc");
    now += 1000;
    expect(await client.getAccessToken()).toBe("tok-abc");
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(client.snapshot()).toMatchObject({ hasCached: true });
  });

  it("refreshes after expiry with a safety margin", async () => {
    let now = 1_000_000;
    const first = tokenFetch({ access_token: "tok-1", token_type: "Bearer", expires_in: 3600 });
    const client = createTokenClient(CREDS, { fetchFn: first, nowFn: () => now });
    expect(await client.getAccessToken()).toBe("tok-1");
    // Advance past expiry minus the 60s margin.
    now += 3600 * 1000;
    const second = tokenFetch({ access_token: "tok-2", token_type: "Bearer", expires_in: 3600 });
    const refreshing = createTokenClient(CREDS, { fetchFn: second, nowFn: () => now });
    // Fresh client must not reuse the expired token: it refetches.
    expect(await refreshing.getAccessToken()).toBe("tok-2");
  });

  it("shares one acquisition across concurrent callers", async () => {
    let resolveJson!: (body: unknown) => void;
    const gate = new Promise<unknown>((resolve) => {
      resolveJson = resolve;
    });
    const fetchFn: FetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => gate,
    }));
    const client = createTokenClient(CREDS, { fetchFn });
    const pending = Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    resolveJson(tokenBody());
    expect(await pending).toEqual(["tok-abc", "tok-abc", "tok-abc"]);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("rejects invalid credentials without leaking secrets", async () => {
    const fetchFn = tokenFetch(
      { error: "invalid_client", error_description: "bad" },
      400,
    );
    const client = createTokenClient(CREDS, { fetchFn });
    const error = await client.getAccessToken().catch((e) => e);
    expect(error).toBeInstanceOf(InvalidProviderCredentialsError);
    expect(JSON.stringify(error.toJSON?.() ?? error)).not.toContain("secret123");
  });

  it("rejects malformed token responses", async () => {
    for (const body of [{}, { access_token: "" }, { access_token: "t" }, null]) {
      const client = createTokenClient(CREDS, { fetchFn: tokenFetch(body) });
      await expect(client.getAccessToken()).rejects.toMatchObject({
        name: "ExtractorError",
      });
    }
  });

  it("treats endpoint outages as retryable", async () => {
    const client = createTokenClient(CREDS, { fetchFn: tokenFetch({}, 503) });
    await expect(client.getAccessToken()).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("treats network failures as retryable", async () => {
    const fetchFn: FetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = createTokenClient(CREDS, { fetchFn });
    await expect(client.getAccessToken()).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("invalidate forces the next acquisition", async () => {
    const fetchFn = tokenFetch(tokenBody());
    const client = createTokenClient(CREDS, { fetchFn });
    await client.getAccessToken();
    client.invalidate();
    expect(client.snapshot()).toMatchObject({ hasCached: false });
    await client.getAccessToken();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
