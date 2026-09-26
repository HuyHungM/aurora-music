// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";

function stubServiceWorker(
  implementation?: Partial<{
    register: (url: string) => Promise<unknown>;
    getRegistrations: () => Promise<
      Array<{
        unregister(): Promise<boolean>;
        readonly active: { scriptURL: string } | null;
        readonly waiting: { scriptURL: string } | null;
        readonly installing: { scriptURL: string } | null;
      }>
    >;
  }>,
) {
  const register =
    implementation?.register ?? (async () => ({ scope: "/" }));
  const getRegistrations =
    implementation?.getRegistrations ?? (async () => []);
  Object.defineProperty(window.navigator, "serviceWorker", {
    value: { register: vi.fn(register), getRegistrations: vi.fn(getRegistrations) },
    configurable: true,
    writable: true,
  });
  return window.navigator as Navigator & {
    serviceWorker: {
      register: ReturnType<typeof vi.fn>;
      getRegistrations: ReturnType<typeof vi.fn>;
    };
  };
}

function removeServiceWorker() {
  const nav = window.navigator as unknown as Record<string, unknown>;
  if ("serviceWorker" in nav) {
    delete nav.serviceWorker;
  }
}

async function settle() {
  window.dispatchEvent(new Event("load"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  cleanup();
  removeServiceWorker();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("service worker registration", () => {
  it("registers /sw.js once after load without blocking render", async () => {
    const { serviceWorker: worker } = stubServiceWorker();
    const { container } = render(<ServiceWorkerRegister />);
    expect(container.firstChild).toBeNull();
    await settle();
    expect(worker.register).toHaveBeenCalledTimes(1);
    expect(worker.register).toHaveBeenCalledWith("/sw.js");
  });

  it("fails silently when registration rejects", async () => {
    const { serviceWorker: worker } = stubServiceWorker({
      register: async () => {
        throw new Error("denied");
      },
    });
    render(<ServiceWorkerRegister />);
    await settle();
    expect(worker.register).toHaveBeenCalledWith("/sw.js");
    // No error escapes into React or the test run.
  });

  it("does nothing without service worker support", async () => {
    removeServiceWorker();
    expect(() => render(<ServiceWorkerRegister />)).not.toThrow();
    await settle();
  });

  it("never registers outside production (development isolation)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { serviceWorker: worker } = stubServiceWorker();
    render(<ServiceWorkerRegister />);
    await settle();
    expect(worker.register).not.toHaveBeenCalled();
  });

  it("releases a stale Aurora worker instead of registering in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const unregister = vi.fn(async () => true);
    const { serviceWorker: worker } = stubServiceWorker({
      getRegistrations: async () => [
        {
          unregister,
          active: { scriptURL: "http://localhost:3000/sw.js" },
          waiting: null,
          installing: null,
        },
      ],
    });
    render(<ServiceWorkerRegister />);
    await settle();
    expect(worker.register).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
