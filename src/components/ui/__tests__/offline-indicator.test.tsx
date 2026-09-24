// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { StrictMode } from "react";
import {
  OfflineIndicator,
  useOnlineStatus,
} from "@/components/ui/offline-indicator";

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    value,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
  setOnline(true);
});

describe("useOnlineStatus", () => {
  it("reflects offline and online events with cleanup", () => {
    function Probe() {
      return <div>{useOnlineStatus() ? "online" : "offline"}</div>;
    }
    setOnline(true);
    const { unmount } = render(<Probe />);
    expect(screen.getByText("online")).toBeTruthy();
    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText("offline")).toBeTruthy();
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByText("online")).toBeTruthy();
    unmount();
    // Post-teardown events are harmless.
    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
  });

  it("survives StrictMode remounts with a single subscription", () => {
    function Probe() {
      return <div>{useOnlineStatus() ? "online" : "offline"}</div>;
    }
    setOnline(false);
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(screen.getByText("offline")).toBeTruthy();
    expect(screen.queryAllByText("offline")).toHaveLength(1);
  });

  it("is SSR-safe and renders nothing while online", () => {
    expect(() => renderToString(<OfflineIndicator />)).not.toThrow();
    expect(renderToString(<OfflineIndicator />)).not.toContain(
      "You&#x27;re offline",
    );
  });
});

describe("OfflineIndicator", () => {
  it("shows only while offline and hides on reconnect", () => {
    setOnline(true);
    render(<OfflineIndicator />);
    expect(screen.queryByRole("status")).toBeNull();
    setOnline(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("You're offline");
    expect(banner.textContent).toContain("internet connection");
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
