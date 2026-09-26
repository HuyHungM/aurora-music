import { describe, expect, it, vi } from "vitest";
import {
  SERVICE_WORKER_URL,
  isOwnRegistration,
  releaseStaleDevelopmentWorkers,
  shouldRegisterServiceWorker,
} from "@/lib/pwa/service-worker";

describe("service worker registration boundary", () => {
  it("registers only in production", () => {
    expect(shouldRegisterServiceWorker("production")).toBe(true);
    expect(shouldRegisterServiceWorker("development")).toBe(false);
    expect(shouldRegisterServiceWorker("test")).toBe(false);
    expect(shouldRegisterServiceWorker(undefined)).toBe(false);
  });

  it("recognizes only own /sw.js registrations", () => {
    expect(
      isOwnRegistration({
        unregister: async () => true,
        active: { scriptURL: "http://localhost:3000/sw.js" },
        waiting: null,
        installing: null,
      }),
    ).toBe(true);
    expect(
      isOwnRegistration({
        unregister: async () => true,
        active: { scriptURL: "https://example.com/other-sw.js" },
        waiting: null,
        installing: null,
      }),
    ).toBe(false);
    expect(
      isOwnRegistration({
        unregister: async () => true,
        active: null,
        waiting: null,
        installing: null,
      }),
    ).toBe(false);
  });

  it("unregisters own workers and leaves foreign workers alone", async () => {
    const ownUnregister = vi.fn(async () => true);
    const foreignUnregister = vi.fn(async () => true);
    await releaseStaleDevelopmentWorkers({
      getRegistrations: async () => [
        {
          unregister: ownUnregister,
          active: { scriptURL: `${SERVICE_WORKER_URL}` },
          waiting: null,
          installing: null,
        },
        {
          unregister: foreignUnregister,
          active: { scriptURL: "https://cdn.example.com/worker.js" },
          waiting: null,
          installing: null,
        },
      ],
    });
    expect(ownUnregister).toHaveBeenCalledTimes(1);
    expect(foreignUnregister).not.toHaveBeenCalled();
  });

  it("resolves silently without container support or on failure", async () => {
    await expect(
      releaseStaleDevelopmentWorkers(undefined),
    ).resolves.toBeUndefined();
    await expect(
      releaseStaleDevelopmentWorkers({}),
    ).resolves.toBeUndefined();
    await expect(
      releaseStaleDevelopmentWorkers({
        getRegistrations: async () => {
          throw new Error("denied");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
