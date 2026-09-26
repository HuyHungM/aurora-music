import { describe, expect, it, vi } from "vitest";
import {
  isFormatConsumable,
  probeFormatConsumability,
} from "@/lib/providers/youtube/playback/format-validation";

function response(status: number, contentType?: string): Response {
  return {
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? (contentType ?? null) : null),
    },
    body: { cancel: vi.fn(async () => undefined) },
  } as unknown as Response;
}

function asFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return impl as unknown as typeof fetch;
}

/** Records the Range header of every probe so ordering/shape can be asserted. */
function rangeRecorder(responses: Array<() => Promise<Response>>) {
  const ranges: string[] = [];
  let i = 0;
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    ranges.push(String((init?.headers as Record<string, string> | undefined)?.Range));
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return next ? await next() : response(200);
  });
  return { fetchFn: asFetch(fetchFn), ranges };
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

describe("probeFormatConsumability verdicts", () => {
  it("accepts a valid AAC candidate and reports 206", async () => {
    const verdict = await probeFormatConsumability("https://cdn.example/a.m4a", {
      fetchFn: asFetch(async () => response(206, "audio/mp4")),
    });
    expect(verdict).toMatchObject({ consumable: true, reason: "consumable", status: 206 });
  });

  it("accepts a valid Opus candidate and reports 206", async () => {
    const verdict = await probeFormatConsumability("https://cdn.example/a.webm", {
      fetchFn: asFetch(async () => response(206, "audio/webm")),
    });
    expect(verdict).toMatchObject({ consumable: true, reason: "consumable", status: 206 });
  });

  it("normalizes a parameterized Content-Type instead of matching it exactly", async () => {
    const verdict = await probeFormatConsumability("https://cdn.example/a.m4a", {
      fetchFn: asFetch(async () => response(206, 'audio/mp4; codecs="mp4a.40.2"')),
    });
    expect(verdict.consumable).toBe(true);
    expect(verdict.contentType).toBe("audio/mp4");
  });

  it("does not gate on Content-Type: an unexpected type is still consumable", async () => {
    // Server-side validation answers "is this source reachable and playable",
    // not "can this browser decode it" (ARCHITECTURE.md 13). A browser-only
    // capability check here would reject valid sources, and a strict
    // content-type match would reject legitimate parameterized responses.
    const verdict = await probeFormatConsumability("https://cdn.example/a.bin", {
      fetchFn: asFetch(async () => response(206, "application/octet-stream")),
    });
    expect(verdict).toMatchObject({ consumable: true, reason: "consumable" });
    expect(verdict.contentType).toBe("application/octet-stream");
  });

  it("rejects a missing url without touching the network", async () => {
    const fetchFn = vi.fn(async () => response(206));
    const verdict = await probeFormatConsumability("", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(verdict).toEqual({ consumable: false, reason: "missing_url" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [403, "probe_status_403"],
    [404, "probe_status_404"],
    [416, "probe_status_416"],
    [500, "probe_status_other"],
    [302, "probe_status_other"],
  ])("maps status %i to %s", async (status, reason) => {
    const verdict = await probeFormatConsumability("https://cdn.example/a.m4a", {
      fetchFn: asFetch(async () => response(status as number)),
    });
    expect(verdict).toMatchObject({ consumable: false, reason, status });
  });

  it("distinguishes a timeout from a transport failure", async () => {
    const timedOut = await probeFormatConsumability("https://cdn.example/a.m4a", {
      fetchFn: asFetch(
        (_url, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
      timeoutMs: 20,
    });
    expect(timedOut).toEqual({ consumable: false, reason: "probe_timeout" });

    const broken = await probeFormatConsumability("https://cdn.example/a.m4a", {
      fetchFn: asFetch(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(broken).toEqual({ consumable: false, reason: "probe_network_error" });
  });

  it("confirms a 403 with one bounded read and flags the whole-body refusal", async () => {
    // The measured YouTube behaviour: the adaptive audio URL answers 403 to
    // any whole-body read and 206 to a bounded one. The flag is what lets a log
    // say "alive but whole-body refused" instead of "dead".
    const { fetchFn, ranges } = rangeRecorder([
      async () => response(403, "text/plain"),
      async () => response(206, "audio/mp4"),
    ]);
    const verdict = await probeFormatConsumability("https://cdn.example/a.m4a", { fetchFn });
    expect(verdict).toMatchObject({
      consumable: false,
      reason: "probe_status_403",
      status: 403,
      contentType: "text/plain",
      boundedRangeOk: true,
    });
    expect(ranges).toEqual(["bytes=0-", "bytes=0-1023"]);
  });

  it("leaves boundedRangeOk unset when the bounded read also fails (a dead url)", async () => {
    const { fetchFn } = rangeRecorder([
      async () => response(403),
      async () => response(403),
    ]);
    const verdict = await probeFormatConsumability("https://cdn.example/a.m4a", { fetchFn });
    expect(verdict).toMatchObject({ consumable: false, reason: "probe_status_403" });
    expect(verdict.boundedRangeOk).toBeUndefined();
  });

  it("does not pay for a confirmation read on an unambiguous 404", async () => {
    const { fetchFn, ranges } = rangeRecorder([async () => response(404)]);
    const verdict = await probeFormatConsumability("https://cdn.example/a.m4a", { fetchFn });
    expect(verdict.reason).toBe("probe_status_404");
    expect(ranges).toEqual(["bytes=0-"]);
  });

  it("never promotes a candidate the browser would still fail on", async () => {
    // A bounded read succeeding must NOT flip the verdict: Chromium issues the
    // whole-body request first and would still get ORB / code 4. Regression
    // guard for the original MEDIA_ERR_SRC_NOT_SUPPORTED bug.
    const { fetchFn } = rangeRecorder([
      async () => response(403),
      async () => response(206),
    ]);
    const verdict = await probeFormatConsumability("https://cdn.example/a.m4a", { fetchFn });
    expect(verdict.consumable).toBe(false);
  });

  it("sends the browser-shaped open-ended range first, always", async () => {
    const { fetchFn, ranges } = rangeRecorder([async () => response(206)]);
    await probeFormatConsumability("https://cdn.example/a.m4a", { fetchFn });
    expect(ranges[0]).toBe("bytes=0-");
    expect(ranges).toHaveLength(1);
  });
});
