// @vitest-environment jsdom
/**
 * Search field navigation (search reload / query persistence bugfix).
 *
 * The bug these lock down was a native `<form action="/search" method="get">`
 * on both the header and the `/search` page. A GET form is a real browser
 * document navigation, which tore down `PlayerHost` — the layout component
 * that owns the audio engine and whose cleanup calls `music.shutdown()` —
 * so submitting a search stopped playback. These tests assert the App
 * Router is used, the URL is the source of truth, and the field cannot
 * drift from the query the page rendered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchField } from "../search-field";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/",
  query: "",
}));

/** Minimal stand-in for the read-only object `useSearchParams` returns. */
function params() {
  const sp = new URLSearchParams(mocks.query);
  return {
    get: (key: string) => sp.get(key),
    has: (key: string) => sp.has(key),
  };
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => params(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.pathname = "/";
  mocks.query = "";
});

function renderField(props: Partial<Parameters<typeof SearchField>[0]> = {}) {
  return render(
    <SearchField
      id="q"
      variant="page"
      label="Search tracks"
      placeholder="Search…"
      clearLabel="Clear search"
      {...props}
    />,
  );
}

const input = () => screen.getByRole("searchbox") as HTMLInputElement;

describe("SearchField: URL is the source of truth", () => {
  it("initializes the input from the query the page rendered", () => {
    renderField({ defaultValue: "test" });
    expect(input().value).toBe("test");
  });

  it("mirrors ?q= when no server query is supplied (the header)", () => {
    mocks.query = "q=from-url";
    renderField({ variant: "header" });
    expect(input().value).toBe("from-url");
  });

  it("follows the URL when it changes underneath a mounted field", () => {
    // Back/forward, or arriving from another route: the client component is
    // not remounted, so it has to re-read the URL rather than keep stale
    // typing state.
    mocks.query = "q=first";
    const { rerender } = renderField({ variant: "header" });
    expect(input().value).toBe("first");

    mocks.query = "q=second";
    rerender(
      <SearchField
        id="q"
        variant="header"
        label="Search tracks"
        placeholder="Search…"
        clearLabel="Clear search"
      />,
    );
    expect(input().value).toBe("second");
  });
});

describe("SearchField: submission", () => {
  it("pushes the query instead of navigating the document", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(input(), "test{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/search?q=test");
  });

  it("uses App Router navigation, never a native form action", () => {
    // Structural guard on the root cause. A reintroduced
    // `action="/search" method="get"` passes every behavioural test in this
    // file under jsdom (which does not implement form submission) and only
    // fails in a real browser, so the attribute itself has to be asserted.
    const { container } = renderField();
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    expect(form!.getAttribute("action")).toBeNull();
    expect(form!.getAttribute("method")).toBeNull();
  });

  it("percent-encodes a Vietnamese query", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(input(), "Sơn Tùng M-TP{Enter}");
    expect(mocks.push).toHaveBeenCalledWith(
      "/search?q=S%C6%A1n%20T%C3%B9ng%20M-TP",
    );
  });

  it("trims the edges and keeps meaningful internal spaces", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(input(), "  Sơn Tùng M-TP  {Enter}");
    expect(mocks.push).toHaveBeenCalledWith(
      "/search?q=S%C6%A1n%20T%C3%B9ng%20M-TP",
    );
  });

  it("clearing a live search drops the query parameter entirely", async () => {
    const user = userEvent.setup();
    mocks.pathname = "/search";
    mocks.query = "q=test";
    renderField({ defaultValue: "test" });
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/search"));
    // No meaningless `?q=` is ever produced.
    expect(
      mocks.push.mock.calls.every(([url]) => !String(url).includes("q=")),
    ).toBe(true);
  });

  it("submits an emptied query to the bare search route", async () => {
    const user = userEvent.setup();
    renderField({ defaultValue: "test" });
    await user.clear(input());
    await user.type(input(), "{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/search");
  });

  it("does not re-navigate when the same query is submitted again", async () => {
    const user = userEvent.setup();
    mocks.pathname = "/search";
    mocks.query = "q=test";
    renderField({ defaultValue: "test" });
    await user.click(input());
    await user.keyboard("{Enter}");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("navigates when a different query is submitted from the search page", async () => {
    const user = userEvent.setup();
    mocks.pathname = "/search";
    mocks.query = "q=test";
    renderField({ defaultValue: "test" });
    await user.clear(input());
    await user.type(input(), "other{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/search?q=other");
  });

  it("navigates even for the current query when off the search route", async () => {
    const user = userEvent.setup();
    mocks.pathname = "/library";
    renderField({ defaultValue: "test" });
    await user.click(input());
    await user.keyboard("{Enter}");
    expect(mocks.push).toHaveBeenCalledWith("/search?q=test");
  });
});

/**
 * Why there is no search-debounce test here, stated as a test.
 *
 * A quota phase's instinct is to add a client-side debounce so that typing a
 * query does not fire a request per keystroke. Aurora's search is
 * SUBMIT-driven: there is no keystroke-to-request path, so there is nothing to
 * debounce and a debounce would be code guarding against a bug that cannot
 * happen. Adding one would also be a silent behaviour change — a delay before
 * a search the user explicitly asked for.
 *
 * The absence is asserted rather than assumed. If live search-as-you-type is
 * ever added, this test fails, and whoever adds it has to confront the request
 * cost per keystroke rather than discovering it in a quota report. The
 * protection that actually exists is server-side: in-flight coalescing plus a
 * TTL cache (`innertube/cache.ts`), which collapses repeated identical queries
 * whatever the client does.
 */
describe("SearchField: request cost per keystroke", () => {
  it("issues no navigation while typing, only on submit", async () => {
    const user = userEvent.setup();
    mocks.pathname = "/search";
    renderField();
    // A full query typed one character at a time.
    await user.type(input(), "son tung 2019");
    // Not one request per prefix. This is the property a debounce would be
    // protecting, held by the absence of the feature rather than by a timer.
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("issues exactly one request for one submission", async () => {
    const user = userEvent.setup();
    renderField();
    await user.type(input(), "son tung{Enter}");
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of identical submissions into one request", async () => {
    // Rapid Enter presses are the closest thing this UI has to a request
    // storm, and the existing same-query guard already collapses them: the
    // query is in the URL, so re-submitting it is a no-op rather than a
    // second navigation.
    const user = userEvent.setup();
    mocks.pathname = "/search";
    mocks.query = "q=son%20tung";
    renderField({ defaultValue: "son tung" });
    await user.click(input());
    await user.keyboard("{Enter}{Enter}{Enter}");
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("SearchField: accessibility", () => {
  it("exposes an accessible name from its label", () => {
    renderField();
    expect(screen.getByRole("searchbox", { name: "Search tracks" })).toBeTruthy();
  });

  it("labels the clear control with the action, not the placeholder", () => {
    renderField({ defaultValue: "test" });
    const clear = screen.getByRole("button", { name: "Clear search" });
    expect(clear.getAttribute("aria-label")).toBe("Clear search");
  });

  it("keeps focus in the field after clearing", async () => {
    const user = userEvent.setup();
    renderField({ defaultValue: "test" });
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("");
  });

  it("hides the clear control when there is nothing to clear", () => {
    renderField();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
  });
});

/**
 * The "Spotify link detected" / "YouTube link detected" hint (feature §10).
 *
 * The property that matters is not the wording but WHERE the work happens:
 * classification is pure string comparison against the value already in
 * state, so the hint costs zero requests. Search here is submit-driven, so
 * this is also the only client-side signal a user gets before submitting —
 * it must therefore appear for a supported link and stay silent for anything
 * else, rather than promise a resolution the server will then refuse.
 */
describe("SearchField: provider link detection", () => {
  const TEMPLATE = "{provider} link detected";

  it("announces a Spotify link as soon as one is in the field", async () => {
    const user = userEvent.setup();
    renderField({ linkDetectedTemplate: TEMPLATE });
    await user.type(input(), "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQ3");
    expect(screen.getByRole("status").textContent).toBe("Spotify link detected");
  });

  it("announces a YouTube link from any supported host", async () => {
    const user = userEvent.setup();
    renderField({ linkDetectedTemplate: TEMPLATE });
    await user.type(input(), "https://youtu.be/dQw4w9WgXcQ?si=abc");
    expect(screen.getByRole("status").textContent).toBe("YouTube link detected");
  });

  it("says nothing for ordinary text", async () => {
    const user = userEvent.setup();
    renderField({ linkDetectedTemplate: TEMPLATE });
    await user.type(input(), "Sơn Tùng M-TP");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("says nothing for a link this build cannot resolve", async () => {
    const user = userEvent.setup();
    renderField({ linkDetectedTemplate: TEMPLATE });
    await user.type(input(), "https://open.spotify.com/artist/6Ub0qfYbXNoUvufHmuvafC");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("is a hint, not a second search: detecting issues no navigation", async () => {
    const user = userEvent.setup();
    renderField({ linkDetectedTemplate: TEMPLATE });
    await user.type(input(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).not.toBe("");
  });

  it("is absent from the header field, which keeps its existing layout", async () => {
    renderField({ variant: "header", linkDetectedTemplate: TEMPLATE });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the live region mounted so a screen reader can announce into it", () => {
    // A node that is inserted *with* its text is frequently missed by screen
    // readers; the region has to exist first and change afterwards. That is
    // also why an empty region renders here rather than nothing at all.
    renderField({ linkDetectedTemplate: TEMPLATE });
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    expect(region.tagName).toBe("P");
  });
});
