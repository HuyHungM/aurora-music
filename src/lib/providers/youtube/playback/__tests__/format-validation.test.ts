import { describe, expect, it, vi } from "vitest";
import { isFormatConsumable } from "@/lib/providers/youtube/playback/format-validation";

function response(status: number): Response {
  return {
    status,
    body: { cancel: vi.fn(async () => undefined) },
  } as unknown as Response;
}

describe("isFormatConsumable", () => {
  it("accepts open-ended range success without downloading media", async () => {
    const fetchFn = vi.fn(async () => response(206));
    const ok = await isFormatConsumable("https://cdn.example/a.m4a", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const call = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((call[1].headers as Record<string, string>).Range).toBe("bytes=0-");
  });

  it("accepts 200 as playable", async () => {
    const fetchFn = vi.fn(async () => response(200));
    await expect(
      isFormatConsumable("https://cdn.example/a.m4a", {
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).resolves.toBe(true);
  });

  it("rejects provider refusals (403, 404, 416)", async () => {
    for (const status of [403, 404, 416, 500]) {
      const fetchFn = vi.fn(async () => response(status));
      await expect(
        isFormatConsumable("https://cdn.example/a.m4a", {
          fetchFn: fetchFn as unknown as typeof fetch,
        }),
      ).resolves.toBe(false);
    }
  });

  it("treats network failures and timeouts as unconsumable", async () => {
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      isFormatConsumable("https://cdn.example/a.m4a", {
        fetchFn: failing as unknown as typeof fetch,
      }),
    ).resolves.toBe(false);

    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    await expect(
      isFormatConsumable("https://cdn.example/a.m4a", {
        fetchFn: hanging as unknown as typeof fetch,
        timeoutMs: 20,
      }),
    ).resolves.toBe(false);
  });
});
