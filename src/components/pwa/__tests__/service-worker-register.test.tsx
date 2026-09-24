// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";

function stubServiceWorker(
  implementation?: Partial<{
    register: (url: string) => Promise<unknown>;
  }>,
) {
  const register =
    implementation?.register ?? (async () => ({ scope: "/" }));
  Object.defineProperty(window.navigator, "serviceWorker", {
    value: { register: vi.fn(register) },
    configurable: true,
    writable: true,
  });
  return (window.navigator as Navigator & { serviceWorker: { register: ReturnType<typeof vi.fn> } })
    .serviceWorker;
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

afterEach(() => {
  cleanup();
  removeServiceWorker();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("service worker registration", () => {
  it("registers /sw.js once after load without blocking render", async () => {
    const worker = stubServiceWorker();
    const { container } = render(<ServiceWorkerRegister />);
    expect(container.firstChild).toBeNull();
    await settle();
    expect(worker.register).toHaveBeenCalledTimes(1);
    expect(worker.register).toHaveBeenCalledWith("/sw.js");
  });

  it("fails silently when registration rejects", async () => {
    const worker = stubServiceWorker({
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
});
