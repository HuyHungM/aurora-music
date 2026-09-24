// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  mockPush: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.mockPush }),
}));

import AppError from "@/app/(app)/error";

afterEach(() => {
  cleanup();
});

function makeError(digest?: string) {
  const err = new Error("test error") as Error & { digest?: string };
  if (digest) err.digest = digest;
  return err;
}

describe("AppError", () => {
  it("renders heading and description", () => {
    render(<AppError error={makeError()} reset={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByText(/unexpected error occurred/)).toBeTruthy();
  });

  it("shows digest when provided", () => {
    render(<AppError error={makeError("abc123")} reset={vi.fn()} />);
    expect(screen.getByText("Reference: abc123")).toBeTruthy();
  });

  it("hides digest when absent", () => {
    render(<AppError error={makeError()} reset={vi.fn()} />);
    expect(screen.queryByText(/Reference:/)).toBeNull();
  });

  it("calls reset when Try again is clicked", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<AppError error={makeError()} reset={reset} />);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("navigates home when Back to home is clicked", async () => {
    const user = userEvent.setup();
    mocks.mockPush.mockClear();
    render(<AppError error={makeError()} reset={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Back to home" }));
    expect(mocks.mockPush).toHaveBeenCalledWith("/");
  });

  it("shows the mapped safe message and code", () => {
    render(<AppError error={makeError()} reset={vi.fn()} />);
    expect(screen.getByText("Something went wrong. Please try again.")).toBeTruthy();
    expect(screen.getByText("Error code: UNKNOWN_ERROR")).toBeTruthy();
  });

  it("shows the offline hint when the browser is offline", () => {
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true,
      writable: true,
    });
    try {
      render(<AppError error={makeError()} reset={vi.fn()} />);
      expect(screen.getByText(/You're offline/)).toBeTruthy();
    } finally {
      Object.defineProperty(window.navigator, "onLine", {
        value: true,
        configurable: true,
        writable: true,
      });
    }
  });

  it("never renders raw provider internals", () => {
    const hostile = new Error(
      "boom https://rr1.googlevideo.com/v?sig=x apiKey=1",
    ) as Error & { digest?: string };
    render(<AppError error={hostile} reset={vi.fn()} />);
    expect(document.body.textContent ?? "").not.toContain("googlevideo");
    expect(document.body.textContent ?? "").not.toContain("apiKey");
  });
});
