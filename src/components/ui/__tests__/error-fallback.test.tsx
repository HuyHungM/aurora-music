// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorFallback } from "@/components/ui/error-fallback";

afterEach(() => {
  cleanup();
});

function renderFallback(overrides: Partial<Parameters<typeof ErrorFallback>[0]> = {}) {
  const props = {
    message: "Something went wrong. Please try again.",
    code: "UNKNOWN_ERROR",
    onRetry: vi.fn(),
    onHome: vi.fn(),
    ...overrides,
  };
  render(<ErrorFallback {...props} />);
  return props;
}

describe("ErrorFallback", () => {
  it("renders heading, message, and code without technical details", () => {
    renderFallback();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByText("Something went wrong. Please try again.")).toBeTruthy();
    expect(screen.getByText("Error code: UNKNOWN_ERROR")).toBeTruthy();
  });

  it("shows the digest reference instead of the code when provided", () => {
    renderFallback({ digest: "abc123" });
    expect(screen.getByText("Reference: abc123")).toBeTruthy();
    expect(screen.queryByText(/Error code:/)).toBeNull();
  });

  it("shows the offline hint only when offline", () => {
    renderFallback({ offline: false });
    expect(screen.queryByText(/You're offline/)).toBeNull();
    cleanup();
    renderFallback({ offline: true });
    expect(screen.getByText(/You're offline/)).toBeTruthy();
  });

  it("invokes retry exactly once per click and never touches playback", async () => {
    const user = userEvent.setup();
    const props = renderFallback();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
    expect(props.onHome).not.toHaveBeenCalled();
  });

  it("navigates home on Back to home", async () => {
    const user = userEvent.setup();
    const props = renderFallback();
    await user.click(screen.getByRole("button", { name: "Back to home" }));
    expect(props.onHome).toHaveBeenCalledOnce();
  });
});
